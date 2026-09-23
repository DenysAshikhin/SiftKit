import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  OrchestratorAbortRequestSchema,
  OrchestratorDecideRequestSchema,
  OrchestratorStartRequestSchema,
  isOrchestratorTerminalPhase,
  type OrchestratorRunState,
} from '@siftkit/contracts';

import { toError } from '../../lib/errors.js';
import type { JsonObject } from '../../lib/json-types.js';
import { OPERATION_STREAM_EVENTS } from '../../lib/operation-stream.js';
import { z } from '../../lib/zod.js';
import { OrchestratorRun, type OrchestratorApprovalAnswer } from '../../orchestrator/run.js';
import { parseJsonBody, readBody, sendBodyReadError, sendJson } from '../http-utils.js';
import { rejectNestedAgentSelfCall } from '../nested-agent-call-guard.js';
import type { RouteEndpoint, RouteMatch } from '../route-table.js';
import type { ServerContext } from '../server-types.js';
import { SseResponseWriter } from '../sse-response-writer.js';

const OrchestratorEventsRequestSchema = z.object({
  runId: z.string().uuid(),
  afterSequence: z.number().int().nonnegative(),
}).strict();

const OrchestratorStatusQuerySchema = z.string().uuid();

async function readJsonBody(req: IncomingMessage, res: ServerResponse): Promise<JsonObject | null> {
  try {
    return parseJsonBody(await readBody(req));
  } catch (error) {
    sendBodyReadError(res, toError(error), { error: 'Expected valid JSON object.' });
    return null;
  }
}

function knownRun(ctx: ServerContext, res: ServerResponse, runId: string): OrchestratorRunState | null {
  try {
    return ctx.orchestratorRunStore.read(runId);
  } catch {
    sendJson(res, 404, { error: `Unknown orchestrator run ${runId}.` });
    return null;
  }
}

/** Reserves the parent, starts it once, and answers with its committed state; the run outlives the request. */
export class OrchestratorStartEndpoint implements RouteEndpoint {
  async handle(ctx: ServerContext, req: IncomingMessage, res: ServerResponse, _match: RouteMatch): Promise<void> {
    const body = await readJsonBody(req, res);
    if (body === null || rejectNestedAgentSelfCall(ctx, req, res, 'repo-search')) return;
    const parsed = OrchestratorStartRequestSchema.safeParse(body);
    if (!parsed.success) {
      sendJson(res, 400, { error: `Invalid orchestrator request: ${parsed.error.issues.map((issue) => issue.message).join('; ')}` });
      return;
    }
    try {
      sendJson(res, 202, OrchestratorRun.start(ctx, parsed.data));
    } catch (error) {
      sendJson(res, 400, { error: toError(error).message });
    }
  }
}

const RECENT_RUN_LIMIT = 10;

/** Recent parents of one repository, newest first; a reloaded surface reattaches to them. */
export class OrchestratorListEndpoint implements RouteEndpoint {
  async handle(ctx: ServerContext, req: IncomingMessage, res: ServerResponse, _match: RouteMatch): Promise<void> {
    const repoRoot = new URL(req.url || '/', 'http://localhost').searchParams.get('repoRoot')?.trim() ?? '';
    if (repoRoot === '') {
      sendJson(res, 400, { error: 'Expected a repoRoot.' });
      return;
    }
    sendJson(res, 200, { runs: ctx.orchestratorRunStore.listRecent(repoRoot, RECENT_RUN_LIMIT) });
  }
}

export class OrchestratorStatusEndpoint implements RouteEndpoint {
  async handle(ctx: ServerContext, req: IncomingMessage, res: ServerResponse, _match: RouteMatch): Promise<void> {
    const runId = OrchestratorStatusQuerySchema.safeParse(new URL(req.url || '/', 'http://localhost').searchParams.get('runId'));
    if (!runId.success) {
      sendJson(res, 400, { error: 'Expected a valid orchestrator runId.' });
      return;
    }
    const state = knownRun(ctx, res, runId.data);
    if (state !== null) sendJson(res, 200, state);
  }
}

/**
 * Replays committed events after the cursor, then follows new commits until the run is terminal.
 * Dropping the connection only detaches; it never stops the run.
 */
export class OrchestratorEventsEndpoint implements RouteEndpoint {
  async handle(ctx: ServerContext, req: IncomingMessage, res: ServerResponse, _match: RouteMatch): Promise<void> {
    const body = await readJsonBody(req, res);
    if (body === null) return;
    const parsed = OrchestratorEventsRequestSchema.safeParse(body);
    if (!parsed.success) {
      sendJson(res, 400, { error: 'Expected runId and a nonnegative integer afterSequence.' });
      return;
    }
    const { runId } = parsed.data;
    const initial = knownRun(ctx, res, runId);
    if (initial === null) return;
    const committed = ctx.orchestratorRunStore.readEvents(runId, 0).length;
    if (parsed.data.afterSequence > committed) {
      sendJson(res, 400, { error: `Cursor ${parsed.data.afterSequence} is past the ${committed} committed events.` });
      return;
    }
    const writer = new SseResponseWriter(req, res);
    writer.open();
    let cursor = parsed.data.afterSequence;
    let finished = false;
    let detach: () => void = () => {};
    const flush = (state: OrchestratorRunState): void => {
      if (finished) return;
      for (const event of ctx.orchestratorRunStore.readEvents(runId, cursor)) {
        writer.writeEvent(OPERATION_STREAM_EVENTS.progress, event);
        cursor = event.sequence;
      }
      // A nonterminal parent with no live owner can never change again; report it as it stands.
      if (isOrchestratorTerminalPhase(state.phase) || ctx.orchestratorRuns.get(runId) === undefined) {
        finished = true;
        detach();
        writer.writeEvent(OPERATION_STREAM_EVENTS.result, state);
        writer.end();
      }
    };
    detach = ctx.orchestratorRuns.subscribe(runId, flush);
    res.on('close', () => detach());
    flush(ctx.orchestratorRunStore.read(runId));
  }
}

function toAnswer(request: z.infer<typeof OrchestratorDecideRequestSchema>): OrchestratorApprovalAnswer {
  switch (request.decision) {
    case 'approve': return { decision: 'approve' };
    case 'deny': return { decision: 'deny', reason: request.reason };
    case 'abort': return { decision: 'abort' };
  }
}

/** Forwards a decision only to the run's current recorded approval, by its exact ID. */
export class OrchestratorDecideEndpoint implements RouteEndpoint {
  async handle(ctx: ServerContext, req: IncomingMessage, res: ServerResponse, _match: RouteMatch): Promise<void> {
    const body = await readJsonBody(req, res);
    if (body === null) return;
    const parsed = OrchestratorDecideRequestSchema.safeParse(body);
    if (!parsed.success) {
      sendJson(res, 400, { error: 'Expected runId, approvalId, decision (approve|deny|abort), and a reason for deny.' });
      return;
    }
    const state = knownRun(ctx, res, parsed.data.runId);
    if (state === null) return;
    const live = ctx.orchestratorRuns.get(state.runId);
    const accepted = live instanceof OrchestratorRun
      && state.approval?.approval.approvalId === parsed.data.approvalId
      && live.decide(parsed.data.approvalId, toAnswer(parsed.data));
    if (!accepted) {
      sendJson(res, 409, { error: `Approval ${parsed.data.approvalId} is not pending for orchestrator run ${state.runId}.` });
      return;
    }
    sendJson(res, 200, ctx.orchestratorRunStore.read(state.runId));
  }
}

export class OrchestratorAbortEndpoint implements RouteEndpoint {
  async handle(ctx: ServerContext, req: IncomingMessage, res: ServerResponse, _match: RouteMatch): Promise<void> {
    const body = await readJsonBody(req, res);
    if (body === null) return;
    const parsed = OrchestratorAbortRequestSchema.safeParse(body);
    if (!parsed.success) {
      sendJson(res, 400, { error: 'Expected a valid orchestrator runId.' });
      return;
    }
    const state = knownRun(ctx, res, parsed.data.runId);
    if (state === null) return;
    const live = ctx.orchestratorRuns.get(state.runId);
    if (live === undefined) {
      sendJson(res, 409, { error: `Orchestrator run ${state.runId} is ${state.phase} and has nothing to abort.` });
      return;
    }
    live.abort('Aborted by user.');
    await live.settled;
    sendJson(res, 200, ctx.orchestratorRunStore.read(state.runId));
  }
}
