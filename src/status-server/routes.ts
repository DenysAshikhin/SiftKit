/**
 * HTTP route dispatcher for the status server. Delegates to domain-specific
 * route handlers in `routes/`.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson } from './http-utils.js';
import { handleDashboardRoute } from './routes/dashboard.js';
import { handleChatRoute } from './routes/chat.js';
import { handleCoreRoute } from './routes/core.js';
import type { ServerContext } from './server-types.js';
import { handleInferencePassthroughRoute } from './routes/inference-passthrough.js';
import { handleAssistantRoute } from './routes/assistant.js';

async function dispatch(ctx: ServerContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const requestUrl = new URL(req.url || '/', 'http://127.0.0.1');
  const pathname = requestUrl.pathname;

  if (await handleAssistantRoute(ctx, req, res, pathname)) return;
  if (await handleDashboardRoute(ctx, req, res, pathname, requestUrl)) return;
  if (await handleChatRoute(ctx, req, res, pathname)) return;
  if (await handleInferencePassthroughRoute(ctx, req, res, pathname)) return;
  if (await handleCoreRoute(ctx, req, res)) return;

  sendJson(res, 404, { error: 'Not found' });
}

/**
 * The server owns the last error boundary: an unhandled throw here would otherwise
 * surface as an unhandled rejection and kill the whole process, so one bad row or one
 * malformed request would take the dashboard down instead of failing its own request.
 */
export function createRequestHandler(ctx: ServerContext): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    try {
      await dispatch(ctx, req, res);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[siftKitStatus] ${req.method || 'GET'} ${req.url || '/'} failed: ${message}\n`);
      if (res.headersSent) {
        res.end();
        return;
      }
      sendJson(res, 500, { error: message });
    }
  };
}
