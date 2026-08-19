import type { IncomingMessage, ServerResponse } from 'node:http';
import { toError } from '../../lib/errors.js';
import { JsonRecordReader } from '../../lib/json-record-reader.js';
import type { JsonObject, JsonSerializable } from '../../lib/json-types.js';
import { OPERATION_STREAM_EVENTS } from '../../lib/operation-stream.js';
import { sleep } from '../../lib/time.js';
import { readConfig } from '../config-store.js';
import { readBody, parseJsonBody, sendBodyReadError, sendJson } from '../http-utils.js';
import { RepoSearchResponseSanityChecker } from '../../repo-search/response-sanity.js';
import {
  INTERACTIVE_REPO_TOOL_NAMES,
  sanitizeNonInteractiveAllowedTools,
} from '../../repo-search/planner-protocol.js';
import {
  ApprovalGate,
  RepoSearchApprovalRequestSchema,
  toApprovalDecision,
} from '../../repo-search/engine/approval-gate.js';
import {
  createRepoSearchAdmissionRecord,
  markRepoSearchAdmissionFailed,
  upsertRepoSearchAdmission,
  type RepoSearchAdmissionRecord,
} from '../repo-search-admissions.js';
import { normalizeRepoSearchMockCommandResults } from '../repo-search-request-normalizers.js';
import { parseRepoSearchRequest, type RepoSearchRouteRequest } from '../route-request-normalizers.js';
import { LoggedRepoSearchSseProgressWriter } from '../operation-progress-writers.js';
import { SseResponseWriter } from '../sse-response-writer.js';
import type { RepoAgentSession } from '../repo-agent-sessions.js';
import type { ServerContext } from '../server-types.js';
import {
  StreamedOperationEndpoint,
  type ParsedStreamedRequest,
  type StreamedOperationContext,
} from './streamed-operation-endpoint.js';
import type { RouteEndpoint, RouteMatch } from '../route-table.js';

type ParsedRepoSearchRoute = {
  parsedBody: JsonObject;
  repoSearchRequest: RepoSearchRouteRequest;
  admission: RepoSearchAdmissionRecord;
};

export class RepoSearchEndpoint extends StreamedOperationEndpoint<ParsedRepoSearchRoute> {
  protected readonly lockKind = 'repo_search';
  protected readonly taskKind = 'repo-search';

  protected parseRequest(parsedBody: JsonObject, ctx: ServerContext): ParsedStreamedRequest<ParsedRepoSearchRoute> {
    const repoSearchRequest = parseRepoSearchRequest(parsedBody);
    if (!repoSearchRequest) {
      return { ok: false, error: 'Expected prompt.' };
    }
    const admission = createRepoSearchAdmissionRecord(repoSearchRequest, readConfig(ctx.configPath));
    upsertRepoSearchAdmission(admission);
    return { ok: true, value: { parsedBody, repoSearchRequest, admission } };
  }

  protected onOperationFailed(parsed: ParsedRepoSearchRoute, errorMessage: string): void {
    markRepoSearchAdmissionFailed(parsed.admission, errorMessage);
  }

  protected lockOwnerRunId(parsed: ParsedRepoSearchRoute): string | null {
    return parsed.admission.requestId;
  }

  protected async execute(
    ctx: ServerContext,
    parsed: ParsedRepoSearchRoute,
    stream: StreamedOperationContext,
  ): Promise<JsonSerializable> {
    const { parsedBody, repoSearchRequest, admission } = parsed;
    const reader = new JsonRecordReader(parsedBody);
    if (Number.isFinite(Number(parsedBody.simulateWorkMs)) && Number(parsedBody.simulateWorkMs) > 0) {
      await sleep(Math.max(1, Math.trunc(Number(parsedBody.simulateWorkMs))));
    }
    const config = readConfig(ctx.configPath);
    const interactive = parsedBody.interactive === true;
    const requestedAllowedTools = Array.isArray(parsedBody.allowedTools)
      ? parsedBody.allowedTools.map((value) => String(value))
      : undefined;
    const approvalMode = interactive ? 'interactive' : 'off';
    const approvalOn = approvalMode !== 'off';
    const allowedTools = interactive
      ? [...INTERACTIVE_REPO_TOOL_NAMES]
      : sanitizeNonInteractiveAllowedTools(requestedAllowedTools);
    const progressWriter = new LoggedRepoSearchSseProgressWriter(stream, admission.requestId);
    const approvalGate = approvalOn
      ? new ApprovalGate({
        requestId: admission.requestId,
        progressWriter,
        abortSignal: stream.abortSignal,
        bypassReadOnlyTools: false,
      })
      : undefined;
    if (approvalGate) {
      ctx.approvalGates.set(admission.requestId, approvalGate);
    }
    try {
      const result = await ctx.engineService.executeRepoSearch({
        presetId: 'repo-search',
        taskKind: 'repo-search',
        prompt: repoSearchRequest.prompt,
        requestId: admission.requestId,
        startedAtUtc: admission.startedAtUtc,
        additionalPromptPrefix: reader.optionalString('promptPrefix'),
        repoRoot: admission.repoRoot,
        statusBackendUrl: `${ctx.getServiceBaseUrl()}/status`,
        config,
        allowedTools,
        model: reader.optionalString('model'),
        maxTurns: reader.number('maxTurns') ?? undefined,
        logFile: reader.optionalString('logFile'),
        availableModels: Array.isArray(parsedBody.availableModels) ? parsedBody.availableModels.map((value) => String(value)) : undefined,
        mockResponses: Array.isArray(parsedBody.mockResponses) ? parsedBody.mockResponses.map((value) => String(value)) : undefined,
        mockCommandResults: normalizeRepoSearchMockCommandResults(parsedBody.mockCommandResults),
        initialUserImages: repoSearchRequest.images.length > 0 ? repoSearchRequest.images : undefined,
        abortSignal: stream.abortSignal,
        progressWriter,
        approvalGate,
        approvalMode,
      });
      RepoSearchResponseSanityChecker.assertSafeToSend(result);
      return result;
    } finally {
      if (approvalGate) {
        ctx.approvalGates.delete(admission.requestId);
      }
    }
  }
}

export async function streamSessionBoundary(
  session: RepoAgentSession,
  req: IncomingMessage,
  res: ServerResponse,
  sinceRevision: number,
): Promise<void> {
  const writer = new SseResponseWriter(req, res);
  writer.open();
  const detach = session.attach({
    writeProgress: (event) => writer.writeEvent(OPERATION_STREAM_EVENTS.progress, event),
  });
  const boundaryController = new AbortController();
  const handleClose = () => {
    detach();
    boundaryController.abort(new Error('Client disconnected.'));
  };
  res.on('close', handleClose);
  try {
    const result = await session.waitForBoundary(sinceRevision, boundaryController.signal);
    writer.writeEvent(OPERATION_STREAM_EVENTS.result, result);
  } catch (error) {
    if (!boundaryController.signal.aborted) {
      throw error;
    }
  } finally {
    res.off('close', handleClose);
    detach();
    writer.end();
  }
}

export class RepoSearchApprovalEndpoint implements RouteEndpoint {
  async handle(ctx: ServerContext, req: IncomingMessage, res: ServerResponse, _match: RouteMatch): Promise<void> {
    let parsedBody: JsonObject;
    try {
      parsedBody = parseJsonBody(await readBody(req));
    } catch (error) {
      sendBodyReadError(res, toError(error), { error: 'Expected valid JSON object.' });
      return;
    }
    const parsedRequest = RepoSearchApprovalRequestSchema.safeParse(parsedBody);
    if (!parsedRequest.success) {
      sendJson(res, 400, { error: 'Expected requestId, approvalId, and decision (approve|deny|abort).' });
      return;
    }
    const gate = ctx.approvalGates.get(parsedRequest.data.requestId);
    if (!gate) {
      sendJson(res, 404, { error: `No interactive run with requestId ${parsedRequest.data.requestId}.` });
      return;
    }
    if (!gate.submit(parsedRequest.data.approvalId, toApprovalDecision(parsedRequest.data))) {
      sendJson(res, 409, { error: 'Approval already resolved or unknown approvalId.' });
      return;
    }
    sendJson(res, 200, { accepted: true });
  }
}
