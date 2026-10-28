import type { IncomingMessage, ServerResponse } from 'node:http';

import { toError } from '../../lib/errors.ts';
import { sendJson } from '../http-utils.ts';
import { RouteTable } from '../route-table.ts';
import type { ServerContext } from '../server-types.ts';
import {
  backupEndpoint,
  backgroundDecisionsEndpoint,
  configPatchEndpoint,
  configReadEndpoint,
  custodyEndpoint,
  capturesPendingEndpoint,
  desktopStateEndpoint,
  exportEndpoint,
  factoryResetEndpoint,
  factoryResetPreviewEndpoint,
  keyExportEndpoint,
  keyImportEndpoint,
  restoreEndpoint,
  restorePreviewEndpoint,
  statusEndpoint,
} from './assistant/admin-routes.ts';
import {
  activityEndpoint,
  captureEndpoint,
  environmentEndpoint,
  suppressionEndpoint,
} from './assistant/ingest-routes.ts';
import {
  vaultAttachmentEndpoint,
  vaultCreateNoteEndpoint,
  vaultDeleteNoteEndpoint,
  vaultExportEndpoint,
  vaultGraphEndpoint,
  vaultListNotesEndpoint,
  vaultLocalGraphEndpoint,
  vaultNoteDetailEndpoint,
  vaultRenameNoteEndpoint,
  vaultResolveEndpoint,
  vaultRestoreEndpoint,
  vaultReviewEndpoint,
  vaultRevisionEndpoint,
  vaultRevisionsEndpoint,
  vaultSearchEndpoint,
  vaultStatsEndpoint,
  vaultTreeEndpoint,
  vaultTriageEndpoint,
  vaultUpdateNoteEndpoint,
} from './assistant/vault-routes.ts';
import { assistantErrorResponse, header, sendError } from './assistant/helpers.ts';

const routes = new RouteTable([
  { method: 'GET', path: '/assistant/status', endpoint: statusEndpoint },
  { method: 'GET', path: '/assistant/background-decisions', endpoint: backgroundDecisionsEndpoint },
  { method: 'GET', path: '/assistant/config', endpoint: configReadEndpoint },
  { method: 'PATCH', path: '/assistant/config', endpoint: configPatchEndpoint },
  { method: 'GET', path: '/assistant/keys/custody', endpoint: custodyEndpoint },
  { method: 'POST', path: '/assistant/keys/export', endpoint: keyExportEndpoint },
  { method: 'POST', path: '/assistant/keys/import', endpoint: keyImportEndpoint },
  { method: 'POST', path: '/assistant/ingest/environment', endpoint: environmentEndpoint },
  { method: 'POST', path: '/assistant/ingest/activity', endpoint: activityEndpoint },
  { method: 'POST', path: '/assistant/ingest/capture', endpoint: captureEndpoint },
  { method: 'POST', path: '/assistant/ingest/suppression', endpoint: suppressionEndpoint },
  {
    method: 'GET', path: '/assistant/factory-reset/preview', endpoint: factoryResetPreviewEndpoint,
  },
  { method: 'POST', path: '/assistant/factory-reset', endpoint: factoryResetEndpoint },
  { method: 'POST', path: '/assistant/export', endpoint: exportEndpoint },
  { method: 'POST', path: '/assistant/backup', endpoint: backupEndpoint },
  { method: 'POST', path: '/assistant/restore-preview', endpoint: restorePreviewEndpoint },
  { method: 'POST', path: '/assistant/restore', endpoint: restoreEndpoint },
  { method: 'GET', path: '/assistant/captures/pending', endpoint: capturesPendingEndpoint },
  { method: 'GET', path: '/assistant/desktop/state', endpoint: desktopStateEndpoint },
  { method: 'GET', path: '/assistant/vault/tree', endpoint: vaultTreeEndpoint },
  { method: 'GET', path: '/assistant/vault/notes', endpoint: vaultListNotesEndpoint },
  { method: 'POST', path: '/assistant/vault/notes', endpoint: vaultCreateNoteEndpoint },
  { method: 'GET', path: /^\/assistant\/vault\/notes\/([^/]+)$/u, endpoint: vaultNoteDetailEndpoint },
  { method: 'PUT', path: /^\/assistant\/vault\/notes\/([^/]+)$/u, endpoint: vaultUpdateNoteEndpoint },
  { method: 'DELETE', path: /^\/assistant\/vault\/notes\/([^/]+)$/u, endpoint: vaultDeleteNoteEndpoint },
  { method: 'POST', path: /^\/assistant\/vault\/notes\/([^/]+)\/rename$/u, endpoint: vaultRenameNoteEndpoint },
  { method: 'GET', path: /^\/assistant\/vault\/notes\/([^/]+)\/revisions$/u, endpoint: vaultRevisionsEndpoint },
  {
    method: 'GET', path: /^\/assistant\/vault\/notes\/([^/]+)\/revisions\/(\d+)$/u,
    endpoint: vaultRevisionEndpoint,
  },
  { method: 'POST', path: /^\/assistant\/vault\/notes\/([^/]+)\/restore$/u, endpoint: vaultRestoreEndpoint },
  { method: 'POST', path: /^\/assistant\/vault\/notes\/([^/]+)\/triage$/u, endpoint: vaultTriageEndpoint },
  { method: 'GET', path: '/assistant/vault/resolve', endpoint: vaultResolveEndpoint },
  { method: 'GET', path: /^\/assistant\/vault\/attachments\/(.+)$/u, endpoint: vaultAttachmentEndpoint },
  { method: 'GET', path: '/assistant/vault/search', endpoint: vaultSearchEndpoint },
  { method: 'GET', path: '/assistant/vault/graph', endpoint: vaultGraphEndpoint },
  { method: 'GET', path: /^\/assistant\/vault\/graph\/local\/([^/]+)$/u, endpoint: vaultLocalGraphEndpoint },
  { method: 'GET', path: '/assistant/vault/review', endpoint: vaultReviewEndpoint },
  { method: 'GET', path: '/assistant/vault/stats', endpoint: vaultStatsEndpoint },
  { method: 'POST', path: '/assistant/vault/export', endpoint: vaultExportEndpoint },
]);

export async function handleAssistantRoute(
  ctx: ServerContext,
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  if (!pathname.startsWith('/assistant/')) return false;
  const guard = ctx.assistantRouteGuard;
  if (guard === null) {
    sendError(res, 503, 'assistant_unavailable', 'Assistant authorization is unavailable.');
    return true;
  }
  const bootstrap = pathname === '/assistant/auth/bootstrap' && req.method === 'GET';
  const authorization = guard.authorize({
    remoteAddress: req.socket.remoteAddress ?? null,
    host: header(req, 'host'),
    origin: header(req, 'origin'),
    authorization: header(req, 'authorization'),
  }, bootstrap ? 'bootstrap' : 'bearer');
  if (authorization.kind === 'denied') {
    sendError(res, authorization.statusCode, 'unauthorized', 'Assistant route unavailable.');
    return true;
  }
  if (bootstrap && 'token' in authorization) {
    res.setHeader('Cache-Control', authorization.cacheControl);
    sendJson(res, 200, { token: authorization.token });
    return true;
  }
  const token = (header(req, 'authorization') ?? '').slice('Bearer '.length);
  if (!ctx.assistantRateLimiter.consume(token, req.method === 'GET' ? 'read' : 'mutation')) {
    sendError(res, 429, 'rate_limited', 'Assistant request rate exceeded.');
    return true;
  }
  if (!routes.hasPath(pathname)) {
    sendError(res, 404, 'not_found', 'Not found.');
    return true;
  }
  try {
    if (!await routes.handle(ctx, req, res, pathname)) {
      sendError(res, 404, 'not_found', 'Not found.');
    }
  } catch (error) {
    const wire = assistantErrorResponse(toError(error));
    sendError(res, wire.status, wire.code, wire.message, wire.details);
  }
  return true;
}
