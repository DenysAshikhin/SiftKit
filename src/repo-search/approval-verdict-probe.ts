import type { SiftConfig } from '../config/index.js';
import { estimateTokenCount } from '../lib/token-estimate.js';
import { ProgressWriter } from '../lib/progress-writer.js';
import { renderWirePrompt } from './wire-prompt.js';
import { z } from '../lib/zod.js';
import type { RepoSearchProgressEvent } from './types.js';
import { MessageContentSchema } from '../llm-protocol/image-attachments.js';
import { InferenceToolDefinitionsSchema, type InferenceToolDefinition } from '../llm-protocol/types.js';
import { ApprovalVerdictSchema } from './approval-verdict.js';
import {
  isApprovalExemptReadOnlyTool,
  type ApprovalDecision,
  type HumanApprovalRequestInput,
  type HumanApprovalRequester,
} from './engine/approval-gate.js';
import {
  LlmApprovalGate,
  type ApprovalVerdictRequester,
} from './engine/llm-approval-gate.js';
import {
  captureExecutingPlannerRequest,
  buildApprovalVerdictPromptMessages,
  requestApprovalVerdict,
  serializeProtocolMessages,
  type ChatMessage,
  type PlannerActionResponse,
  type PlannerThinkingFlags,
} from './planner-protocol.js';

const ReplayToolCallSchema = z.object({
  id: z.string(),
  type: z.string(),
  function: z.object({
    name: z.string(),
    arguments: z.string(),
  }),
});

export const ReplayMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  // Parts, not just a string: a replayed transcript can contain an image turn.
  content: MessageContentSchema.optional(),
  reasoning_content: z.string().optional(),
  tool_calls: z.array(ReplayToolCallSchema).optional(),
  tool_call_id: z.string().optional(),
});

export const AutoApprovalActionSchema = z.object({
  turn: z.number().int().positive(),
  toolName: z.string().min(1),
  command: z.string().min(1),
  reviewPayload: z.string().nullable(),
  pendingMessages: z.array(ReplayMessageSchema).default([]),
});

export const AutoApprovalReplayPayloadSchema = z.object({
  messages: z.array(ReplayMessageSchema).min(1),
  tools: InferenceToolDefinitionsSchema.min(1),
  action: AutoApprovalActionSchema,
});
export type AutoApprovalReplayPayload = z.infer<typeof AutoApprovalReplayPayloadSchema>;
export type AutoApprovalReplayPayloadInput = z.input<typeof AutoApprovalReplayPayloadSchema>;

const AutoApprovalEventSchema = z.object({
  kind: z.literal('approval_auto'),
  verdict: ApprovalVerdictSchema.shape.verdict,
  reason: z.string(),
});

export const AutoApprovalProbeResultSchema = z.object({
  submittedMessages: z.array(ReplayMessageSchema),
  action: AutoApprovalActionSchema,
  verdict: ApprovalVerdictSchema.shape.verdict,
  reason: z.string(),
});
export type AutoApprovalProbeResult = z.infer<typeof AutoApprovalProbeResultSchema>;

export type ApprovalVerdictModelClient = {
  request(
    messages: ChatMessage[],
    pendingMessages: ChatMessage[],
    question: string,
    tools: readonly InferenceToolDefinition[],
  ): Promise<PlannerActionResponse>;
};

export class ConfiguredApprovalVerdictModelClient implements ApprovalVerdictModelClient {
  constructor(private readonly options: {
    config: SiftConfig;
    baseUrl: string;
    model: string;
    timeoutMs: number;
    thinking: PlannerThinkingFlags;
  }) {}

  request(
    messages: ChatMessage[],
    pendingMessages: ChatMessage[],
    question: string,
    tools: readonly InferenceToolDefinition[],
  ): Promise<PlannerActionResponse> {
    const { thinking, ...request } = this.options;
    return requestApprovalVerdict({
      ...request,
      transcriptMessages: messages,
      pendingMessages,
      question,
      // Replay reconstructs the executing planner request from the persisted
      // messages the live run submitted, with the configured thinking flags. The
      // live prompt measurement is not persisted with them, so a replay prices the
      // reconstructed prompt locally instead.
      executing: captureExecutingPlannerRequest(
        serializeProtocolMessages(messages, thinking.reasoningContentEnabled),
        thinking,
        tools,
        estimateTokenCount(this.options.config, renderWirePrompt({
          messages,
          tools,
          includeReasoningContent: thinking.reasoningContentEnabled,
        }).text),
      ),
      logger: null,
    });
  }
}

class ReplayVerdictRequester implements ApprovalVerdictRequester {
  submittedMessages: ChatMessage[] = [];

  constructor(
    private readonly messages: ChatMessage[],
    private readonly tools: readonly InferenceToolDefinition[],
    private readonly modelClient: ApprovalVerdictModelClient,
  ) {}

  requestApprovalVerdict(
    question: string,
    pendingMessages: ChatMessage[],
  ): Promise<PlannerActionResponse> {
    this.submittedMessages = buildApprovalVerdictPromptMessages(
      this.messages,
      pendingMessages,
      question,
    );
    return this.modelClient.request(this.messages, pendingMessages, question, this.tools);
  }
}

class FailClosedHumanGate implements HumanApprovalRequester {
  request(_input: HumanApprovalRequestInput): Promise<ApprovalDecision> {
    return Promise.resolve({
      kind: 'abort',
      reason: 'Approval verdict probe reached the human gate; failing closed.',
    });
  }
}

class ProbeProgressWriter extends ProgressWriter<RepoSearchProgressEvent> {
  private event: z.infer<typeof AutoApprovalEventSchema> | undefined;

  get enabled(): boolean {
    return true;
  }

  override get wantsLiveText(): boolean {
    return false;
  }

  write(event: RepoSearchProgressEvent): void {
    if (event.kind === 'approval_auto') {
      this.event = AutoApprovalEventSchema.parse(event);
    }
  }

  getEvent(): z.infer<typeof AutoApprovalEventSchema> {
    if (!this.event) {
      throw new Error('Auto-approval reviewer emitted no verdict.');
    }
    return this.event;
  }
}

export class AutoApprovalVerdictProbe {
  constructor(private readonly modelClient: ApprovalVerdictModelClient) {}

  async run(input: AutoApprovalReplayPayloadInput): Promise<AutoApprovalProbeResult> {
    const payload = AutoApprovalReplayPayloadSchema.parse(input);
    if (isApprovalExemptReadOnlyTool(payload.action.toolName)) {
      throw new Error(
        `${payload.action.toolName} is an approval-exempt read-only tool: the reviewer is never `
        + 'consulted for it, so there is no verdict to probe.',
      );
    }
    const requester = new ReplayVerdictRequester(payload.messages, payload.tools, this.modelClient);
    const progressWriter = new ProbeProgressWriter();
    const gate = new LlmApprovalGate({
      requestId: 'auto-approval-verdict-probe',
      humanGate: new FailClosedHumanGate(),
      verdictRequester: requester,
      progressWriter,
      logger: null,
    });

    await gate.request(payload.action);
    const event = progressWriter.getEvent();
    return {
      submittedMessages: requester.submittedMessages,
      action: payload.action,
      verdict: event.verdict,
      reason: event.reason,
    };
  }
}
