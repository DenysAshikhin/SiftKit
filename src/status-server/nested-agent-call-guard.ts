import type { IncomingMessage, ServerResponse } from 'node:http';
import { AGENT_RUN_ID_HEADER } from '../lib/agent-run-marker.ts';
import { recordServerError } from './error-response.ts';
import { sendJson } from './http-utils.ts';
import { getModelRequestQueueDiagnostics } from './server-ops.ts';
import type { ServerContext } from './server-types.ts';

export function rejectNestedAgentSelfCall(
  ctx: ServerContext,
  req: IncomingMessage,
  res: ServerResponse,
  taskKind: 'summary' | 'repo-search',
): boolean {
  const header = req.headers[AGENT_RUN_ID_HEADER];
  const nestedRunId = Array.isArray(header)
    ? (header[0]?.trim() ?? '')
    : (header?.trim() ?? '');
  const ownedActiveLock = nestedRunId
    ? [...ctx.activeModelRequests.values()].find((lock) => lock.ownerRunId === nestedRunId)
    : undefined;
  if (!ownedActiveLock) {
    return false;
  }

  const message = `Rejected self-call from agent run ${nestedRunId}: it holds the model lock, so this request would deadlock behind its own run.`;
  const payload = recordServerError(req, 409, new Error(message), { taskKind });
  sendJson(res, 409, { ...payload, modelRequests: getModelRequestQueueDiagnostics(ctx) });
  return true;
}
