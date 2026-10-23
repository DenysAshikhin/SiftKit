import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  OPERATION_STREAM_EVENTS,
  ORCHESTRATOR_ACTIVITY_FRAME,
  OrchestratorAbortRequestSchema,
  OrchestratorDecideRequestSchema,
  OrchestratorStartRequestSchema,
  isOrchestratorTerminalPhase,
  type OrchestratorActivity,
  type OrchestratorProgress,
  type OrchestratorRunState,
} from '@siftkit/contracts';

import { toError } from '../../lib/errors.ts';
import type { JsonObject } from '../../lib/json-types.ts';
import { z } from '../../lib/zod.ts';
import { OrchestratorRun } from '../../orchestrator/run.ts';
import { parseJsonBody, readBody, sendBodyReadError, sendJson } from '../http-utils.ts';
import { rejectNestedAgentSelfCall } from '../nested-agent-call-guard.ts';
import type { RouteEndpoint, RouteMatch } from '../route-table.ts';
import type { ServerContext } from '../server-types.ts';
import { SseResponseWriter } from '../sse-response-writer.ts';

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
    let detachState: () => void = () => {};
    let detachActivity: () => void = () => {};
    const detach = (): void => {
      detachState();
      detachActivity();
    };
    const flush = (state: OrchestratorRunState): void => {
      if (finished) return;
      const events = ctx.orchestratorRunStore.readEvents(runId, cursor);
      const last = events.at(-1);
      if (last !== undefined) {
        const progress: OrchestratorProgress = { events, state };
        writer.writeEvent(OPERATION_STREAM_EVENTS.progress, progress);
        cursor = last.sequence;
      }
      // A nonterminal parent with no live owner can never change again; report it as it stands.
      if (isOrchestratorTerminalPhase(state.phase) || ctx.orchestratorRuns.get(runId) === undefined) {
        finished = true;
        detach();
        writer.writeEvent(OPERATION_STREAM_EVENTS.result, state);
        writer.end();
      }
    };
    const writeActivity = (activity: OrchestratorActivity): void => {
      if (!finished) writer.writeEvent(ORCHESTRATOR_ACTIVITY_FRAME, activity);
    };
    detachState = ctx.orchestratorRuns.subscribe(runId, flush);
    detachActivity = ctx.orchestratorRuns.subscribeActivity(runId, writeActivity);
    res.on('close', detach);
    flush(ctx.orchestratorRunStore.read(runId));
    // Activity is never stored, so a client that connects mid-run starts from the live snapshot.
    const live = ctx.orchestratorRuns.get(runId);
    if (live !== undefined) writeActivity(live.activitySnapshot());
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
    const { runId, approvalId, ...decision } = parsed.data;
    const state = knownRun(ctx, res, runId);
    if (state === null) return;
    const live = ctx.orchestratorRuns.get(state.runId);
    const accepted = live !== undefined
      && state.approval?.approvalId === approvalId
      && live.decide(approvalId, decision);
    if (!accepted) {
      sendJson(res, 409, { error: `Approval ${approvalId} is not pending for orchestrator run ${state.runId}.` });
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
