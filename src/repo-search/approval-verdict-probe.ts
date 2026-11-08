import type { SiftConfig } from '../config/index.ts';
import { ProgressWriter } from '../lib/progress-writer.ts';
import { z } from '../lib/zod.ts';
import type { RepoSearchProgressEvent } from './types.ts';
import { InferenceToolDefinitionsSchema, type InferenceToolDefinition } from '../llm-protocol/types.ts';
import { ApprovalVerdictSchema } from './approval-verdict.ts';
import {
  isApprovalExemptReadOnlyTool,
  type ApprovalDecision,
  type ApprovalRequestInput,
  type ApprovalRequester,
} from './engine/approval-gate.ts';
import {
  LlmApprovalGate,
  type ApprovalVerdictRequester,
} from './engine/llm-approval-gate.ts';
import {
  buildApprovalVerdictMessages,
  requestApprovalVerdict,
  type PlannerActionResponse,
  type PlannerThinkingFlags,
} from './planner-protocol.ts';
import { PlannerChatMessageSchema, type ChatMessage } from './planner-chat-message.ts';

/** A submitted verdict message, validated with the planner message schema itself; the internal image-path key is never part of one. */
export const ReplayMessageSchema = PlannerChatMessageSchema.omit({ imagePathKey: true });

export const AutoApprovalActionSchema = z.strictObject({
  turn: z.number().int().positive(),
  toolName: z.string().min(1),
  command: z.string().min(1),
  reviewPayload: z.string().nullable(),
});

/** One proposed call and the agent's tool definitions: everything the isolated approver is shown. */
export const AutoApprovalReplayPayloadSchema = z.strictObject({
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
  request(reviewRequest: string, tools: readonly InferenceToolDefinition[]): Promise<PlannerActionResponse>;
};

export class ConfiguredApprovalVerdictModelClient implements ApprovalVerdictModelClient {
  private readonly options: {
    config: SiftConfig;
    baseUrl: string;
    model: string;
    timeoutMs: number;
    thinking: PlannerThinkingFlags;
  };

  constructor(options: {
    config: SiftConfig;
    baseUrl: string;
    model: string;
    timeoutMs: number;
    thinking: PlannerThinkingFlags;
  }) {
    this.options = options;
  }

  request(reviewRequest: string, tools: readonly InferenceToolDefinition[]): Promise<PlannerActionResponse> {
    const { thinking, ...request } = this.options;
    return requestApprovalVerdict({
      ...request,
      // The probe is its own evaluation operation: one verdict request under the probe's id, never
      // attributed to the run it replays.
      throughputAudit: {
        operationType: 'evaluation',
        operationId: 'approval-verdict-probe',
        requestId: 'auto-approval-verdict-probe',
        model: this.options.model,
        presetId: null,
      },
      reviewRequest,
      tools,
      flags: thinking,
      logger: null,
    });
  }
}

class ReplayVerdictRequester implements ApprovalVerdictRequester {
  submittedMessages: ChatMessage[] = [];

  private readonly tools: readonly InferenceToolDefinition[];
  private readonly modelClient: ApprovalVerdictModelClient;

  constructor(tools: readonly InferenceToolDefinition[], modelClient: ApprovalVerdictModelClient) {
    this.tools = tools;
    this.modelClient = modelClient;
  }

  requestApprovalVerdict(reviewRequest: string): Promise<PlannerActionResponse> {
    this.submittedMessages = buildApprovalVerdictMessages(reviewRequest);
    return this.modelClient.request(reviewRequest, this.tools);
  }
}

class FailClosedHumanGate implements ApprovalRequester {
  request(_input: ApprovalRequestInput): Promise<ApprovalDecision> {
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
  private readonly modelClient: ApprovalVerdictModelClient;

  constructor(modelClient: ApprovalVerdictModelClient) {
    this.modelClient = modelClient;
  }

  async run(input: AutoApprovalReplayPayloadInput): Promise<AutoApprovalProbeResult> {
    const payload = AutoApprovalReplayPayloadSchema.parse(input);
    if (isApprovalExemptReadOnlyTool(payload.action.toolName)) {
      throw new Error(
        `${payload.action.toolName} is an approval-exempt read-only tool: the reviewer is never `
        + 'consulted for it, so there is no verdict to probe.',
      );
    }
    const requester = new ReplayVerdictRequester(payload.tools, this.modelClient);
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
