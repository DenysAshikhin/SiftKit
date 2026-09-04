import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { toError } from '../../lib/errors.js';
import type { JsonObject } from '../../lib/json-types.js';
import { OPERATION_STREAM_EVENTS } from '../../lib/operation-stream.js';
import { readBody, parseJsonBody, sendBodyReadError, sendJson } from '../http-utils.js';
import { sendServerErrorJson, recordServerError } from '../error-response.js';
import { rejectNestedAgentSelfCall } from '../nested-agent-call-guard.js';
import { readConfig } from '../config-store.js';
import { INTERACTIVE_REPO_TOOL_NAMES } from '../../planner-protocol/repo-search.js';
import {
  RepoAgentRunIdSchema,
  RepoAgentRunRequestSchema,
  isTerminalStatus,
  repoAgentStateToResult,
} from '../../repo-agent/run-schemas.js';
import {
  RepoAgentDecideRequestSchema,
  RepoAgentStartRequestSchema,
} from '../../repo-agent/api-schemas.js';
import { ServerModelLockAdapter } from '../repo-agent-lock-adapter.js';
import {
  createRepoSearchAdmissionRecord,
  upsertRepoSearchAdmission,
} from '../repo-search-admissions.js';
import type { RepoSearchRouteRequest } from '../route-request-normalizers.js';
import type { ServerContext } from '../server-types.js';
import { SseResponseWriter } from '../sse-response-writer.js';
import { streamSessionBoundary } from './repo-search.js';
import type { RouteEndpoint, RouteMatch } from '../route-table.js';
import type { RepoAgentApprovalDelivery, RepoAgentSession } from '../repo-agent-sessions.js';
import type { RepoSearchAdmissionRecord } from '../repo-search-admissions.js';
import { APPROVAL_MODE_ERROR, type ApprovalMode } from '@siftkit/contracts';
import type { RepoSearchExecutionRequest, RepoSearchMockCommandResult } from '../../repo-search/types.js';
import type { MockPlannerResponseInput } from '../../planner-protocol/mock-response.js';

export class RepoAgentStartEndpoint implements RouteEndpoint {
  async handle(ctx: ServerContext, req: IncomingMessage, res: ServerResponse, _match: RouteMatch): Promise<void> {
    let parsedBody: JsonObject;
    try {
      parsedBody = parseJsonBody(await readBody(req));
    } catch (error) {
      sendBodyReadError(res, toError(error), { error: 'Expected valid JSON object.' });
      return;
    }
    if (rejectNestedAgentSelfCall(ctx, req, res, 'repo-search')) {
      return;
    }
    const parsedRequest = RepoAgentStartRequestSchema.safeParse(parsedBody);
    if (!parsedRequest.success) {
      const approvalIssue = parsedRequest.error.issues.some((issue) => issue.path[0] === 'approval');
      sendJson(res, 400, {
        error: approvalIssue
          ? APPROVAL_MODE_ERROR
          : 'Invalid repo-agent request.',
      });
      return;
    }
    const input = parsedRequest.data;
    const { session } = startRepoAgentRun(ctx, {
      prompt: input.prompt, repoRoot: input.repoRoot,
      approvalMode: input.approval,
      approvalDelivery: input.approval === 'interactive' ? 'progress' : 'boundary',
      model: input.model, maxTurns: input.maxTurns, logFile: input.logFile,
      images: input.images, promptPrefix: input.promptPrefix,
      availableModels: input.availableModels,
      mockResponses: input.mockResponses, mockCommandResults: input.mockCommandResults,
    });
    await streamSessionBoundary(session, req, res, 0);
  }
}

export type StartRepoAgentRunInput = {
  prompt: string;
  repoRoot: string | undefined;
  approvalMode: ApprovalMode;
  approvalDelivery: RepoAgentApprovalDelivery;
  model?: string | null;
  maxTurns?: number;
  logFile?: string;
  images?: string[];
  promptPrefix?: string;
  /** Chat-launched runs pass the session's replayed conversation; standalone callers omit it. */
  history?: RepoSearchExecutionRequest['history'];
  config?: RepoSearchExecutionRequest['config'];
  modelPresetId?: RepoSearchExecutionRequest['modelPresetId'];
  modelPreset?: RepoSearchExecutionRequest['modelPreset'];
  availableModels?: string[];
  mockResponses?: MockPlannerResponseInput[];
  mockCommandResults?: Record<string, RepoSearchMockCommandResult>;
};

export function startRepoAgentRun(ctx: ServerContext, input: StartRepoAgentRunInput): {
  runId: string;
  session: RepoAgentSession;
  admission: RepoSearchAdmissionRecord;
} {
  const repoSearchRequest: RepoSearchRouteRequest = {
    prompt: input.prompt,
    repoRoot: input.repoRoot ?? process.cwd(),
    model: input.model ?? null,
    ...(input.maxTurns === undefined ? {} : { maxTurns: input.maxTurns }),
    images: input.images ?? [],
  };
  const config = input.config ?? readConfig(ctx.configPath);
  const admission = createRepoSearchAdmissionRecord(repoSearchRequest, config);
  upsertRepoSearchAdmission(admission);
  const runId = randomUUID();
  ctx.repoAgentRunStore.create(RepoAgentRunRequestSchema.parse({
    runId,
    task: repoSearchRequest.prompt,
    repoRoot: admission.repoRoot,
    approval: input.approvalMode,
    ...(repoSearchRequest.model === null ? {} : { model: repoSearchRequest.model }),
    ...(input.logFile === undefined ? {} : { logFile: input.logFile }),
    images: repoSearchRequest.images,
  }));
  const session = ctx.repoAgentSessions.start({
    runId,
    requestId: admission.requestId,
    admission,
    approvalMode: input.approvalMode,
    approvalDelivery: input.approvalDelivery,
    locks: new ServerModelLockAdapter(ctx),
    approvalGates: ctx.approvalGates,
    engineRequest: {
      presetId: 'repo-agent',
      taskKind: 'repo-agent',
      prompt: repoSearchRequest.prompt,
      requestId: admission.requestId,
      startedAtUtc: admission.startedAtUtc,
      additionalPromptPrefix: input.promptPrefix,
      repoRoot: admission.repoRoot,
      statusBackendUrl: `${ctx.getServiceBaseUrl()}/status`,
      config,
      modelPresetId: input.modelPresetId,
      modelPreset: input.modelPreset,
      allowedTools: [...INTERACTIVE_REPO_TOOL_NAMES],
      model: input.model ?? undefined,
      maxTurns: input.maxTurns,
      logFile: input.logFile,
      availableModels: input.availableModels,
      mockResponses: input.mockResponses,
      mockCommandResults: input.mockCommandResults,
      ...(input.history === undefined ? {} : { history: input.history }),
      initialUserImages: repoSearchRequest.images.length > 0 ? repoSearchRequest.images : undefined,
    },
  });
  return { runId, session, admission };
}

export class RepoAgentDecideEndpoint implements RouteEndpoint {
  async handle(ctx: ServerContext, req: IncomingMessage, res: ServerResponse, _match: RouteMatch): Promise<void> {
    let parsedBody: JsonObject;
    try {
      parsedBody = parseJsonBody(await readBody(req));
    } catch (error) {
      sendBodyReadError(res, toError(error), { error: 'Expected valid JSON object.' });
      return;
    }
    const parsed = RepoAgentDecideRequestSchema.safeParse(parsedBody);
    if (!parsed.success) {
      sendJson(res, 400, { error: 'Expected runId, decision (approve|deny|abort), and a reason for deny.' });
      return;
    }
    const { runId } = parsed.data;
    const session = ctx.repoAgentSessions.get(runId);
    if (session) {
      const state = session.getState();
      if (isTerminalStatus(state.status)) {
        const writer = new SseResponseWriter(req, res);
        writer.open();
        writer.writeEvent(OPERATION_STREAM_EVENTS.result, repoAgentStateToResult(state));
        writer.end();
        return;
      }
      const observedRevision = session.currentRevision();
      if (!session.submitDecision(parsed.data)) {
        const payload = recordServerError(
          req,
          409,
          new Error(`Run ${runId} has no pending approval.`),
          { taskKind: 'repo-search' },
        );
        sendJson(res, 409, payload);
        return;
      }
      await streamSessionBoundary(session, req, res, observedRevision);
      return;
    }
    try {
      if (!ctx.repoAgentRunStore.hasRun(runId)) {
        sendJson(res, 404, { error: `Unknown repo-agent run ${runId}.` });
        return;
      }
      const state = ctx.repoAgentRunStore.reconcile(runId);
      const finalState = isTerminalStatus(state.status)
        ? state
        : ctx.repoAgentRunStore.markNotResumable(runId);
      const writer = new SseResponseWriter(req, res);
      writer.open();
      writer.writeEvent(OPERATION_STREAM_EVENTS.result, repoAgentStateToResult(finalState));
      writer.end();
    } catch (error) {
      sendServerErrorJson(req, res, 500, error, { taskKind: 'repo-search', requestId: runId });
    }
  }
}

export class RepoAgentStatusEndpoint implements RouteEndpoint {
  async handle(
    _ctx: ServerContext,
    req: IncomingMessage,
    res: ServerResponse,
    _match: RouteMatch,
  ): Promise<void> {
    const parsedUrl = new URL(req.url || '/', 'http://localhost');
    const parsedRunId = RepoAgentRunIdSchema.safeParse(parsedUrl.searchParams.get('runId'));
    if (!parsedRunId.success) {
      sendJson(res, 400, { error: 'Expected a valid repo-agent runId.' });
      return;
    }
    const runId = parsedRunId.data;
    const session = _ctx.repoAgentSessions.get(runId);
    if (session) {
      sendJson(res, 200, session.getState());
      return;
    }
    try {
      if (!_ctx.repoAgentRunStore.hasRun(runId)) {
        sendJson(res, 404, { error: `Unknown repo-agent run ${runId}.` });
        return;
      }
      sendJson(res, 200, _ctx.repoAgentRunStore.reconcile(runId));
    } catch (error) {
      sendServerErrorJson(req, res, 500, error, { taskKind: 'repo-agent', requestId: runId });
    }
  }
}
