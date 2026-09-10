import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  MockPlannerResponsesSchema,
} from '../../planner-protocol/mock-response.js';
import { RepoAgentDecisionSchema } from '../../repo-agent/api-schemas.js';
import {
  APPROVAL_MODE_ERROR,
  ApprovalModeSchema,
  ChatRepoAgentApprovalModeRequestSchema,
  ChatRepoAgentApprovalModeResponseSchema,
  ActiveChatRepoAgentResponseSchema,
  ChatRepoAgentDecideResponseSchema,
  ChatStreamApprovalResolvedSchema,
  type RepoAgentDecision,
} from '@siftkit/contracts';
import {
  RepoSearchMockCommandResultSchema,
} from '../../repo-search/types.js';
import { z } from '../../lib/zod.js';
import type { JsonObject } from '../../lib/json-types.js';
import { toError } from '../../lib/errors.js';
import { readChatSessionFromPath } from '../../state/chat-sessions.js';
import type { SiftConfig } from '../../config/types.js';
import { PresetCatalog } from '../../preset-catalog.js';
import {
  appendChatRepoAgentMessages,
  buildChatHistoryMessages,
  buildRepoAgentResultMarkdown,
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
import { getRuntimeDatabase } from '../../state/runtime-db.js';
import { ChatToolResultsError } from '../chat-tool-results.js';
import { migrateRepoAgentHistory } from '../repo-agent-history-repair.js';
import { normalizeRepoSearchMockCommandResults } from '../repo-search-request-normalizers.js';
import type { RepoAgentApproval } from '../../repo-agent/run-schemas.js';
import {
  toChatStreamApproval,
  type ChatRepoAgentDecisionRecord,
  type ChatRepoAgentRunBinding,
} from '../chat-repo-agent-types.js';
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
import type { ChatRunSubmission } from './chat-session-operation-endpoint.js';
import { buildChatSessionResponse, requireChatOperationBroadcast } from './chat.js';
import { ChatStreamProgressWriter } from '../chat-stream-progress-writer.js';
import type { ChatSession } from '../../state/chat-sessions.js';
import { buildChatRunSettings } from '../chat-run-recorder.js';
import { ChatOperationSseSubscriber } from '../chat-operation-sse-subscriber.js';
import { startRepoAgentRun } from './repo-agent.js';
import type { ChatOperationBroadcast } from '../chat-operation-broadcast.js';
import type { ChatSessionOperation } from '../chat-session-operation-registry.js';

const ChatRepoAgentRequestExtrasSchema = z.strictObject({
  approval: ApprovalModeSchema,
  maxTurns: z.number().int().positive().optional(),
  mockResponses: MockPlannerResponsesSchema.optional(),
  mockCommandResults: z.record(z.string(), RepoSearchMockCommandResultSchema).optional(),
});

type ChatRepoAgentRequest = ResolvedChatRepoRequest & z.infer<typeof ChatRepoAgentRequestExtrasSchema>;

function resolveRepoAgentPresetMaxTurns(
  config: SiftConfig,
  presetId: string | undefined,
): number | undefined {
  if (!presetId) {
    return undefined;
  }
  const preset = PresetCatalog.fromPresets(config.Presets).requireById(presetId);
  return preset.presetKind === 'repo-agent' ? preset.maxTurns ?? undefined : undefined;
}

export class StreamChatRepoAgentEndpoint extends ChatSessionOperationEndpoint<ChatRepoAgentRequest> {
  protected readonly operationKind = 'repo-agent' as const;
  protected readonly clientOwnedOperation = true;

  protected describeRun(
    session: ChatSession,
    value: ChatRepoAgentRequest,
    config: SiftConfig,
  ): ChatRunSubmission {
    return {
      settings: buildChatRunSettings({
        session,
        config,
        operationKind: 'repo-agent',
        repoRoot: value.repoRoot,
        approval: value.approval,
        maxTurns: value.maxTurns ?? null,
      }),
      content: value.content,
      images: value.images,
    };
  }

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
    req: IncomingMessage | null,
    res: ServerResponse | null,
    request: ChatSessionOperationRequest<ChatRepoAgentRequest>,
  ): Promise<void> {
    if (req && res && rejectNestedAgentSelfCall(ctx, req, res, 'repo-search')) {
      return;
    }
    const config = readConfig(ctx.configPath);
    const blockers = migrateRepoAgentHistory(
      getRuntimeDatabase(join(getRuntimeRoot(), 'runtime.sqlite')),
      request.sessionId,
    );
    if (blockers.length > 0) {
      if (!res) throw new Error(`Repo-agent history cannot be verified: ${blockers.join(', ')}`);
      sendJson(res, 409, {
        error: 'Repo-agent history cannot be verified against its source runs: '
          + `${blockers.join(', ')}. The transcript is intact; continuation needs the run evidence.`,
      });
      return;
    }
    // Migration updates persisted outputs. Load only afterwards so this request sees the repair.
    const activeSession = readChatSessionFromPath(request.sessionPath);
    if (!activeSession) {
      if (!res) throw new Error('Session not found.');
      sendJson(res, 404, { error: 'Session not found.' });
      return;
    }
    const effectiveConfig = resolveChatSessionConfig(config, activeSession);
    // Replay enforces the full-result contract itself; a row it refuses is reported here, before
    // any engine dispatch, as the actionable conflict it is.
    let history;
    try {
      history = buildChatHistoryMessages(effectiveConfig, activeSession);
    } catch (error) {
      if (!(error instanceof ChatToolResultsError)) throw error;
      if (!res) throw error;
      sendJson(res, 409, { error: `${error.message} Repair the history before continuing.` });
      return;
    }
    const presetMaxTurns = request.value.maxTurns === undefined
      ? resolveRepoAgentPresetMaxTurns(effectiveConfig, activeSession.presetId)
      : undefined;
    const stream = requireChatOperationBroadcast(ctx, request);
    const sse = req && res ? new SseResponseWriter(req, res) : null;
    try {
      const { updatedSession } = await executeChatRepoAgentOperation({
        ctx,
        sessionId: request.sessionId,
        session: activeSession,
        content: request.value.content,
        images: request.value.images,
        repoRoot: request.value.repoRoot,
        approval: request.value.approval,
        maxTurns: request.value.maxTurns ?? presetMaxTurns,
        mockResponses: request.value.mockResponses,
        mockCommandResults: request.value.mockCommandResults,
        history,
        effectiveConfig,
        stream,
        ...(sse ? { connection: sse } : {}),
        queueStart: request,
        lease: request.lease ?? undefined,
        queueOwner: ctx.chatMessageQueue,
        queueSessionId: request.sessionId,
      });
      stream.writeEvent('done', buildChatSessionResponse(config, updatedSession));
    } catch (error) {
      stream.writeEvent('error', { error: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally {
      sse?.end();
    }
  }
}

/** Shared chat repo-agent execution used by attached streams and detached Force successors. */
export async function executeChatRepoAgentOperation(options: {
  ctx: ServerContext;
  sessionId: string;
  session: ChatSessionOperationRequest<ChatRepoAgentRequest>['session'];
  content: string;
  images: string[];
  repoRoot: string;
  approval: ChatRepoAgentRequest['approval'];
  maxTurns?: number;
  mockResponses?: ChatRepoAgentRequest['mockResponses'];
  mockCommandResults?: ChatRepoAgentRequest['mockCommandResults'];
  history: ReturnType<typeof buildChatHistoryMessages>;
  effectiveConfig: SiftConfig;
  queueOwner?: ServerContext['chatMessageQueue'];
  queueSessionId?: string;
  stream: ChatOperationBroadcast;
  connection?: SseResponseWriter;
  queueStart?: Pick<ChatSessionOperationRequest<ChatRepoAgentRequest>, 'sessionId' | 'queuedMessages' | 'queueIntentId'>;
  lease?: ChatSessionOperation;
}): Promise<{ updatedSession: ReturnType<typeof appendChatRepoAgentMessages> }> {
  const engineRequestId = options.lease?.operationId ?? randomUUID();
  const progressWriter = new ChatStreamProgressWriter(options.stream, null, engineRequestId, false);
  const started = startRepoAgentRun(options.ctx, {
    requestId: engineRequestId,
    prompt: options.content,
    repoRoot: options.repoRoot,
    approvalMode: options.approval,
    approvalDelivery: 'progress',
    images: options.images,
    maxTurns: options.maxTurns,
    history: options.history,
    webToolsEnabled: options.session.webSearchEnabled === true,
    config: options.effectiveConfig,
    modelPresetId: options.session.modelPresetId,
    modelPreset: options.session.modelPreset,
    mockResponses: options.mockResponses,
    mockCommandResults: normalizeRepoSearchMockCommandResults(options.mockCommandResults),
    queueOwner: options.queueOwner,
    queueSessionId: options.queueSessionId,
    queueForceId: options.queueStart?.queueIntentId,
  });
  if (!options.lease || !options.ctx.chatSessionOperations.registerAbort(options.lease, () => started.session.abort())) {
    started.session.abort();
    throw new Error(`Failed to register repo-agent abort for chat session ${options.sessionId}.`);
  }
  const binding: ChatRepoAgentRunBinding = { runId: started.runId, decisions: [] };
  options.ctx.chatRepoAgentRuns.set(options.sessionId, binding);
  if (!options.queueStart?.queuedMessages) options.stream.writeEvent('submitted', { content: options.content, images: options.images });
  if (options.connection) {
    options.connection.open();
    options.stream.attach(new ChatOperationSseSubscriber(options.connection));
  }
  const detach = started.session.attach({
    wantsLiveText: true,
    writeProgress: (event) => {
      if (event.kind === 'approval_request') {
        options.stream.writeEvent('approval', toChatStreamApproval(started.runId, event));
        return;
      }
      if (event.kind === 'lock_wait') return;
      progressWriter.write(event);
    },
  });
  try {
    const result = await started.session.waitForBoundary(0);
    await started.session.settled;
    const telemetry = new ChatTurnTelemetry(options.effectiveConfig, getMockTokenConfig(options.effectiveConfig, options.mockResponses));
    const executionResult = started.session.getExecutionResult();
    const turns = await telemetry.countThinkingTokens(buildPersistTurnsFromRepoSearchResult(executionResult));
    const requestId = started.admission.requestId;
    const updatedSession = appendChatRepoAgentMessages(getRuntimeRoot(), options.sessionId, {
      content: options.content,
      images: options.images,
      decisions: binding.decisions,
      result,
      requestId,
      turns,
      turnRecords: executionResult === null ? [] : executionResult.turnRecords,
      terminalMessages: progressWriter.getStoppedMessages(result.status === 'aborted'
        ? 'Repo-agent run stopped by user.'
        : buildRepoAgentResultMarkdown(result)),
      maintainPerStepThinking: telemetry.shouldMaintainPerStepThinking(options.session),
    });
    progressWriter.flushPending();
    if (result.status !== 'completed' && result.status !== 'aborted' && options.lease) options.lease.failure = buildRepoAgentResultMarkdown(result);
    return { updatedSession };
  } finally {
    detach();
    options.ctx.chatRepoAgentRuns.delete(options.sessionId);
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

/** Tells every reader of this session's stream that a parked approval is now decided. */
function broadcastApprovalResolved(
  ctx: ServerContext,
  sessionId: string,
  runId: string,
  approval: RepoAgentApproval,
  decision: RepoAgentDecision,
  decidedAtUtc: string,
): void {
  const broadcast = ctx.chatSessionOperations.getBroadcast(sessionId);
  if (!broadcast) {
    return;
  }
  broadcast.writeEvent('approval_resolved', ChatStreamApprovalResolvedSchema.parse({
    approval: toChatStreamApproval(runId, approval),
    decision,
    decidedAtUtc,
  }));
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
    broadcastApprovalResolved(ctx, sessionId, binding.runId, approval, parsed.data, record.decidedAtUtc);
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
    if (released && record) {
      broadcastApprovalResolved(ctx, sessionId, binding.runId, released, { decision: 'approve' }, record.decidedAtUtc);
    }
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
    if (state.status === 'running' || state.status === 'approval_required') {
      sendJson(res, 200, ActiveChatRepoAgentResponseSchema.parse(state.status === 'running'
        ? { runId: binding.runId, status: state.status, approvalMode: session.getApprovalMode() }
        : {
            runId: binding.runId,
            status: state.status,
            approvalMode: session.getApprovalMode(),
            approval: state.approval,
          }));
      return;
    }
    sendJson(res, 404, { error: 'No active repo-agent run for this session.' });
  }
}
