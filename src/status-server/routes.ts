/**
 * HTTP route dispatcher for the status server. Delegates to domain-specific
 * route handlers in `routes/`.
 */
import * as http from 'node:http';
import { sendJson } from './http-utils.js';
import { handleDashboardRoute } from './routes/dashboard.js';
import { handleChatRoute } from './routes/chat.js';
import { handleCoreRoute } from './routes/core.js';
import type { ServerContext } from './server-types.js';

export function createRequestHandler(ctx: ServerContext): (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void> {
  return async (req, res) => {
    const requestUrl = new URL(req.url || '/', 'http://127.0.0.1');
    const pathname = requestUrl.pathname;

    if (await handleDashboardRoute(ctx, req, res, pathname, requestUrl)) return;
    if (await handleChatRoute(ctx, req, res, pathname)) return;
    if (await handleCoreRoute(ctx, req, res)) return;

    sendJson(res, 404, { error: 'Not found' });
  };
}
