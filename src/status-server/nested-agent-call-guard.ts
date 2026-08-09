import type { IncomingMessage, ServerResponse } from 'node:http';
import { AGENT_RUN_ID_HEADER } from '../lib/agent-run-marker.js';
import { recordServerError } from './error-response.js';
import { sendJson } from './http-utils.js';
import { getModelRequestQueueDiagnostics } from './server-ops.js';
import type { ServerContext } from './server-types.js';

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
