import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  MockPlannerResponsesSchema,
} from '../../planner-protocol/mock-response.js';
import { RepoAgentDecisionSchema } from '../../repo-agent/api-schemas.js';
import {
  APPROVAL_MODE_ERROR,
  ApprovalModeSchema,
  ChatRepoAgentApprovalModeRequestSchema,
  ChatRepoAgentApprovalModeResponseSchema,
  ChatRepoAgentDecideResponseSchema,
  type RepoAgentDecision,
} from '@siftkit/contracts';
import {
  RepoSearchMockCommandResultSchema,
} from '../../repo-search/types.js';
import { z } from '../../lib/zod.js';
import type { JsonObject } from '../../lib/json-types.js';
import { toError } from '../../lib/errors.js';
import { readChatSessionFromPath } from '../../state/chat-sessions.js';
import {
  appendChatRepoAgentMessages,
  buildChatHistoryMessages,
  buildPersistTurnsFromRepoSearchResult,
  resolveChatSessionConfig,
} from '../chat.js';
import { ChatTurnTelemetry, getMockTokenConfig } from '../chat-turn-telemetry.js';
import { readConfig } from '../config-store.js';
import {
  parseJsonBody,
  readBody,
  sendBodyReadError,
  sendJson,
} from '../http-utils.js';
import { rejectNestedAgentSelfCall } from '../nested-agent-call-guard.js';
import { getRuntimeRoot } from '../paths.js';
import { normalizeRepoSearchMockCommandResults } from '../repo-search-request-normalizers.js';
import type { RepoAgentApproval } from '../../repo-agent/run-schemas.js';
import type { ChatRepoAgentDecisionRecord, ChatRepoAgentRunBinding } from '../chat-repo-agent-types.js';
import type { RepoAgentSession } from '../repo-agent-sessions.js';
import type { ServerContext } from '../server-types.js';
import { SseResponseWriter } from '../sse-response-writer.js';
import type { RouteEndpoint, RouteMatch } from '../route-table.js';
import {
  ChatSessionOperationEndpoint,
  parseChatRepoOperationRequest,
  type ChatSessionOperationRequest,
  type ResolvedChatRepoRequest,
} from './chat-session-operation-endpoint.js';
import { ChatStreamProgressWriter, buildChatSessionResponse } from './chat.js';
import { startRepoAgentRun } from './repo-agent.js';

const ChatRepoAgentRequestExtrasSchema = z.strictObject({
  approval: ApprovalModeSchema,
  maxTurns: z.number().int().positive().optional(),
  mockResponses: MockPlannerResponsesSchema.optional(),
  mockCommandResults: z.record(z.string(), RepoSearchMockCommandResultSchema).optional(),
});

type ChatRepoAgentRequest = ResolvedChatRepoRequest & z.infer<typeof ChatRepoAgentRequestExtrasSchema>;

export class StreamChatRepoAgentEndpoint extends ChatSessionOperationEndpoint<ChatRepoAgentRequest> {
  protected readonly operationKind = 'repo-agent' as const;
  protected readonly clientOwnedOperation = true;

  protected parseRequest(
    res: ServerResponse,
    session: ChatSessionOperationRequest<ChatRepoAgentRequest>['session'],
    parsedBody: JsonObject,
  ): ChatRepoAgentRequest | null {
    const base = parseChatRepoOperationRequest(res, session, parsedBody);
    if (!base) {
      return null;
    }
    const approval = ApprovalModeSchema.safeParse(parsedBody.approval);
    if (!approval.success) {
      sendJson(res, 400, { error: APPROVAL_MODE_ERROR });
      return null;
    }
    const maxTurns = z.number().int().positive().optional().safeParse(parsedBody.maxTurns);
    if (!maxTurns.success) {
      sendJson(res, 400, { error: 'maxTurns must be a positive integer.' });
      return null;
    }
    const mockResponses = MockPlannerResponsesSchema.optional().safeParse(parsedBody.mockResponses);
    const mockCommandResults = z.record(
      z.string(),
      RepoSearchMockCommandResultSchema,
    ).optional().safeParse(parsedBody.mockCommandResults);
    if (!mockResponses.success || !mockCommandResults.success) {
      sendJson(res, 400, { error: 'Invalid repo-agent request.' });
      return null;
    }
    const extras = ChatRepoAgentRequestExtrasSchema.parse({
      approval: approval.data,
      maxTurns: maxTurns.data,
      mockResponses: mockResponses.data,
      mockCommandResults: mockCommandResults.data,
    });
    return { ...base, ...extras };
  }

  protected async run(
    ctx: ServerContext,
    req: IncomingMessage,
    res: ServerResponse,
    request: ChatSessionOperationRequest<ChatRepoAgentRequest>,
  ): Promise<void> {
    if (rejectNestedAgentSelfCall(ctx, req, res, 'repo-search')) {
      return;
    }
    const config = readConfig(ctx.configPath);
    const activeSession = readChatSessionFromPath(request.sessionPath);
    if (!activeSession) {
      sendJson(res, 404, { error: 'Session not found.' });
      return;
    }
    const effectiveConfig = resolveChatSessionConfig(config, activeSession);
    const started = startRepoAgentRun(ctx, {
      prompt: request.value.content,
      repoRoot: request.value.repoRoot,
      approvalMode: request.value.approval,
      approvalDelivery: 'progress',
      images: request.value.images,
      maxTurns: request.value.maxTurns,
      history: buildChatHistoryMessages(effectiveConfig, activeSession),
      config: effectiveConfig,
      modelPresetId: activeSession.modelPresetId,
      modelPreset: activeSession.modelPreset,
      mockResponses: request.value.mockResponses,
      mockCommandResults: normalizeRepoSearchMockCommandResults(request.value.mockCommandResults),
    });
    if (!request.lease || !ctx.chatSessionOperations.registerAbort(request.lease, () => started.session.abort())) {
      started.session.abort();
      throw new Error(`Failed to register repo-agent abort for chat session ${request.sessionId}.`);
    }
    const binding: ChatRepoAgentRunBinding = { runId: started.runId, decisions: [] };
    ctx.chatRepoAgentRuns.set(request.sessionId, binding);
    const sse = new SseResponseWriter(req, res);
    sse.open();
    const progressWriter = new ChatStreamProgressWriter(sse, null, 'rs', started.admission.requestId, false);
    const detach = started.session.attach({
      wantsLiveText: true,
      writeProgress: (event) => {
        if (event.kind === 'approval_request') {
          sse.writeEvent('approval', {
            runId: started.runId,
            approvalId: event.approvalId,
            toolName: event.toolName,
            command: event.command,
            reviewPayload: event.reviewPayload ?? null,
          });
          return;
        }
        if (event.kind === 'lock_wait') {
          return;
        }
        progressWriter.write(event);
      },
    });
    try {
      const result = await started.session.waitForBoundary(0);
      const telemetry = new ChatTurnTelemetry(effectiveConfig, getMockTokenConfig(config, request.value.mockResponses));
      const turns = await telemetry.countThinkingTokens(buildPersistTurnsFromRepoSearchResult(started.session.getExecutionResult()));
      const updatedSession = appendChatRepoAgentMessages(getRuntimeRoot(), request.sessionId, {
        content: request.value.content,
        images: request.value.images,
        decisions: binding.decisions,
        result,
        turns,
        stoppedMessages: progressWriter.getStoppedMessages('Repo-agent run stopped by user.'),
        maintainPerStepThinking: telemetry.shouldMaintainPerStepThinking(activeSession),
      });
      progressWriter.flushPending();
      sse.writeEvent('done', buildChatSessionResponse(config, updatedSession));
    } catch (error) {
      progressWriter.flushPending();
      sse.writeEvent('error', { error: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally {
      detach();
      ctx.chatRepoAgentRuns.delete(request.sessionId);
      sse.end();
    }
  }
}

function resolveActiveChatRepoAgentRun(
  ctx: ServerContext,
  sessionId: string,
  res: ServerResponse,
): { binding: ChatRepoAgentRunBinding; session: RepoAgentSession } | null {
  const binding = ctx.chatRepoAgentRuns.get(sessionId);
  if (!binding) {
    sendJson(res, 409, { error: `Session ${sessionId} has no active repo-agent run.` });
    return null;
  }
  const session = ctx.repoAgentSessions.get(binding.runId);
  if (!session) {
    sendJson(res, 404, { error: `Unknown repo-agent run ${binding.runId}.` });
    return null;
  }
  return { binding, session };
}

function recordChatRepoAgentDecision(
  binding: ChatRepoAgentRunBinding,
  decision: RepoAgentDecision,
  approval: RepoAgentApproval,
): ChatRepoAgentDecisionRecord {
  const record: ChatRepoAgentDecisionRecord = { decision, approval, decidedAtUtc: new Date().toISOString() };
  binding.decisions.push(record);
  return record;
}

export class ChatRepoAgentDecideEndpoint implements RouteEndpoint {
  async handle(
    ctx: ServerContext,
    req: IncomingMessage,
    res: ServerResponse,
    match: RouteMatch,
  ): Promise<void> {
    const sessionId = decodeURIComponent(match.captures[0] ?? '');
    let parsedBody: JsonObject;
    try {
      parsedBody = parseJsonBody(await readBody(req));
    } catch (error) {
      sendBodyReadError(res, toError(error), { error: 'Expected valid JSON object.' });
      return;
    }
    const parsed = RepoAgentDecisionSchema.safeParse(parsedBody);
    if (!parsed.success) {
      sendJson(res, 400, { error: 'Expected decision (approve|deny|abort) and a reason for deny.' });
      return;
    }
    const active = resolveActiveChatRepoAgentRun(ctx, sessionId, res);
    if (!active) {
      return;
    }
    const { binding, session } = active;
    const state = session.getState();
    if (state.status !== 'approval_required') {
      sendJson(res, 409, { error: `Run ${binding.runId} has no pending approval.` });
      return;
    }
    const approval = state.approval;
    if (!session.submitDecision({ ...parsed.data, runId: binding.runId })) {
      sendJson(res, 409, { error: `Run ${binding.runId} has no pending approval.` });
      return;
    }
    const record = recordChatRepoAgentDecision(binding, parsed.data, approval);
    sendJson(res, 200, ChatRepoAgentDecideResponseSchema.parse({
      ok: true, runId: binding.runId, decidedAtUtc: record.decidedAtUtc,
    }));
  }
}

export class ChatRepoAgentApprovalModeEndpoint implements RouteEndpoint {
  async handle(
    ctx: ServerContext,
    req: IncomingMessage,
    res: ServerResponse,
    match: RouteMatch,
  ): Promise<void> {
    const sessionId = decodeURIComponent(match.captures[0] ?? '');
    let parsedBody: JsonObject;
    try {
      parsedBody = parseJsonBody(await readBody(req));
    } catch (error) {
      sendBodyReadError(res, toError(error), { error: 'Expected valid JSON object.' });
      return;
    }
    const parsed = ChatRepoAgentApprovalModeRequestSchema.safeParse(parsedBody);
    if (!parsed.success) {
      sendJson(res, 400, { error: APPROVAL_MODE_ERROR });
      return;
    }
    const active = resolveActiveChatRepoAgentRun(ctx, sessionId, res);
    if (!active) {
      return;
    }
    const { binding, session } = active;
    const released = session.setApprovalMode(parsed.data.approval);
    const record = released ? recordChatRepoAgentDecision(binding, { decision: 'approve' }, released) : null;
    sendJson(res, 200, ChatRepoAgentApprovalModeResponseSchema.parse({
      ok: true,
      runId: binding.runId,
      approval: session.getApprovalMode(),
      released: record ? { approvalId: record.approval.approvalId, decidedAtUtc: record.decidedAtUtc } : null,
    }));
  }
}

export class GetChatRepoAgentActiveEndpoint implements RouteEndpoint {
  handle(
    ctx: ServerContext,
    _req: IncomingMessage,
    res: ServerResponse,
    match: RouteMatch,
  ): void {
    const sessionId = decodeURIComponent(match.captures[0] ?? '');
    const binding = ctx.chatRepoAgentRuns.get(sessionId);
    const session = binding ? ctx.repoAgentSessions.get(binding.runId) : undefined;
    if (!binding || !session) {
      sendJson(res, 404, { error: 'No active repo-agent run for this session.' });
      return;
    }
    const state = session.getState();
    if (state.status === 'running') {
      sendJson(res, 200, { runId: binding.runId, status: state.status, approvalMode: session.getApprovalMode() });
      return;
    }
    if (state.status === 'approval_required') {
      sendJson(res, 200, {
        runId: binding.runId,
        status: state.status,
        approvalMode: session.getApprovalMode(),
        approval: {
          approvalId: state.approval.approvalId,
          toolName: state.approval.toolName,
          command: state.approval.command,
          reviewPayload: state.approval.reviewPayload ?? null,
        },
      });
      return;
    }
    sendJson(res, 404, { error: 'No active repo-agent run for this session.' });
  }
}
