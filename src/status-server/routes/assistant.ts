import type { IncomingMessage, ServerResponse } from 'node:http';

import { AssistantConflictError, AssistantNotFoundError } from '../../assistant/errors.js';
import {
  RequestBodyTooLargeError, sendJson,
} from '../http-utils.js';
import { RouteTable } from '../route-table.js';
import type { ServerContext } from '../server-types.js';
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
  graphCleanupEndpoint,
  graphCleanupPreviewEndpoint,
  keyExportEndpoint,
  keyImportEndpoint,
  restoreEndpoint,
  restorePreviewEndpoint,
  statusEndpoint,
} from './assistant/admin-routes.js';
import {
  activityEndpoint,
  captureEndpoint,
  environmentEndpoint,
  mobileEndpoint,
  suppressionEndpoint,
} from './assistant/ingest-routes.js';
import {
  evidenceBlobEndpoint,
  explainAssertionEndpoint,
  getAssertionEndpoint,
  getEvidenceEndpoint,
  getNodeEndpoint,
  historyEndpoint,
  listAssertionsEndpoint,
  listEvidenceEndpoint,
  listNodesEndpoint,
  listProjectionsEndpoint,
  neighborhoodEndpoint,
  searchEndpoint,
} from './assistant/graph-routes.js';
import {
  claimOwnerEndpoint,
  confirmEndpoint,
  correctEndpoint,
  deleteAssertionEndpoint,
  deleteEvidenceEndpoint,
  evidenceDeletionPreviewEndpoint,
  pinEndpoint,
  rebuildProjectionsEndpoint,
  topicForgetEndpoint,
  topicForgetPreviewEndpoint,
  demoteEndpoint,
} from './assistant/mutation-routes.js';
import {
  answerEndpoint,
  blockTopicEndpoint,
  currentEndpoint,
  dismissEndpoint,
  doNotRepeatEndpoint,
  markShownEndpoint,
  skipEndpoint,
  snoozeEndpoint,
} from './assistant/question-routes.js';
import {
  blockPolicyTopicEndpoint,
  deletePolicyEndpoint,
  deleteValidationEndpoint,
  listPoliciesEndpoint,
  listValidationEndpoint,
  patchPolicyEndpoint,
  resolveIdentityEndpoint,
  validationNotesEndpoint,
} from './assistant/policy-routes.js';
import { header, sendError } from './assistant/helpers.js';

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
  { method: 'GET', path: '/assistant/search', endpoint: searchEndpoint },
  { method: 'GET', path: '/assistant/graph/nodes', endpoint: listNodesEndpoint },
  { method: 'GET', path: /^\/assistant\/graph\/nodes\/([^/]+)$/u, endpoint: getNodeEndpoint },
  {
    method: 'GET', path: /^\/assistant\/graph\/nodes\/([^/]+)\/neighborhood$/u,
    endpoint: neighborhoodEndpoint,
  },
  {
    method: 'POST', path: /^\/assistant\/graph\/nodes\/([^/]+)\/claim-owner$/u,
    endpoint: claimOwnerEndpoint,
  },
  { method: 'GET', path: '/assistant/graph/assertions', endpoint: listAssertionsEndpoint },
  {
    method: 'GET', path: /^\/assistant\/graph\/assertions\/([^/]+)$/u,
    endpoint: getAssertionEndpoint,
  },
  {
    method: 'GET', path: /^\/assistant\/graph\/assertions\/([^/]+)\/explanation$/u,
    endpoint: explainAssertionEndpoint,
  },
  {
    method: 'POST', path: /^\/assistant\/graph\/assertions\/([^/]+)\/confirm$/u,
    endpoint: confirmEndpoint,
  },
  {
    method: 'POST', path: /^\/assistant\/graph\/assertions\/([^/]+)\/correct$/u,
    endpoint: correctEndpoint,
  },
  {
    method: 'POST', path: /^\/assistant\/graph\/assertions\/([^/]+)\/pin$/u,
    endpoint: pinEndpoint,
  },
  {
    method: 'POST', path: /^\/assistant\/graph\/assertions\/([^/]+)\/demote$/u,
    endpoint: demoteEndpoint,
  },
  {
    method: 'DELETE', path: /^\/assistant\/graph\/assertions\/([^/]+)$/u,
    endpoint: deleteAssertionEndpoint,
  },
  { method: 'GET', path: '/assistant/evidence', endpoint: listEvidenceEndpoint },
  { method: 'GET', path: '/assistant/evidence/blob', endpoint: evidenceBlobEndpoint },
  // Ahead of the bare evidence-id route, matching the blob-route ordering above.
  {
    method: 'GET', path: /^\/assistant\/evidence\/([^/]+)\/deletion-preview$/u,
    endpoint: evidenceDeletionPreviewEndpoint,
  },
  {
    method: 'DELETE', path: /^\/assistant\/evidence\/([^/]+)$/u,
    endpoint: deleteEvidenceEndpoint,
  },
  {
    method: 'GET', path: /^\/assistant\/evidence\/([^/]+)$/u,
    endpoint: getEvidenceEndpoint,
  },
  {
    method: 'POST', path: '/assistant/topics/forget-preview', endpoint: topicForgetPreviewEndpoint,
  },
  { method: 'POST', path: '/assistant/topics/forget', endpoint: topicForgetEndpoint },
  {
    method: 'GET', path: '/assistant/factory-reset/preview', endpoint: factoryResetPreviewEndpoint,
  },
  { method: 'POST', path: '/assistant/factory-reset', endpoint: factoryResetEndpoint },
  { method: 'GET', path: '/assistant/cleanup/preview', endpoint: graphCleanupPreviewEndpoint },
  { method: 'POST', path: '/assistant/cleanup', endpoint: graphCleanupEndpoint },
  { method: 'POST', path: '/assistant/export', endpoint: exportEndpoint },
  { method: 'POST', path: '/assistant/backup', endpoint: backupEndpoint },
  { method: 'POST', path: '/assistant/restore-preview', endpoint: restorePreviewEndpoint },
  { method: 'POST', path: '/assistant/restore', endpoint: restoreEndpoint },
  { method: 'POST', path: '/assistant/ingest/mobile', endpoint: mobileEndpoint },
  { method: 'GET', path: '/assistant/projections', endpoint: listProjectionsEndpoint },
  { method: 'POST', path: '/assistant/projections/rebuild', endpoint: rebuildProjectionsEndpoint },
  { method: 'GET', path: '/assistant/captures/pending', endpoint: capturesPendingEndpoint },
  { method: 'GET', path: '/assistant/desktop/state', endpoint: desktopStateEndpoint },
  { method: 'GET', path: '/assistant/questions/current', endpoint: currentEndpoint },
  { method: 'POST', path: '/assistant/questions/mark-shown', endpoint: markShownEndpoint },
  { method: 'POST', path: '/assistant/questions/dismiss', endpoint: dismissEndpoint },
  {
    method: 'POST', path: /^\/assistant\/questions\/([^/]+)\/answer$/u,
    endpoint: answerEndpoint,
  },
  {
    method: 'POST', path: /^\/assistant\/questions\/([^/]+)\/skip$/u,
    endpoint: skipEndpoint,
  },
  {
    method: 'POST', path: /^\/assistant\/questions\/([^/]+)\/snooze$/u,
    endpoint: snoozeEndpoint,
  },
  {
    method: 'POST', path: /^\/assistant\/questions\/([^/]+)\/do-not-repeat$/u,
    endpoint: doNotRepeatEndpoint,
  },
  {
    method: 'POST', path: /^\/assistant\/questions\/([^/]+)\/block-topic$/u,
    endpoint: blockTopicEndpoint,
  },
  { method: 'GET', path: '/assistant/policies', endpoint: listPoliciesEndpoint },
  {
    method: 'POST', path: '/assistant/policies/block-topic', endpoint: blockPolicyTopicEndpoint,
  },
  {
    method: 'PATCH', path: /^\/assistant\/policies\/([^/]+)$/u, endpoint: patchPolicyEndpoint,
  },
  {
    method: 'DELETE', path: /^\/assistant\/policies\/([^/]+)$/u, endpoint: deletePolicyEndpoint,
  },
  { method: 'GET', path: '/assistant/validation', endpoint: listValidationEndpoint },
  {
    method: 'PATCH', path: /^\/assistant\/validation\/([^/]+)\/notes$/u,
    endpoint: validationNotesEndpoint,
  },
  {
    method: 'POST', path: /^\/assistant\/validation\/([^/]+)\/resolve-identity$/u,
    endpoint: resolveIdentityEndpoint,
  },
  {
    method: 'DELETE', path: /^\/assistant\/validation\/([^/]+)$/u,
    endpoint: deleteValidationEndpoint,
  },
  { method: 'GET', path: '/assistant/history', endpoint: historyEndpoint },
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
  const rateKind = pathname.endsWith('/answer')
    ? 'question_answer'
    : req.method === 'GET' ? 'read' : 'mutation';
  if (!ctx.assistantRateLimiter.consume(token, rateKind)) {
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
    if (error instanceof RequestBodyTooLargeError) {
      sendError(res, 413, 'body_too_large', error.message);
    } else {
      const message = error instanceof Error ? error.message : String(error);
      const status = error instanceof AssistantNotFoundError
        ? 404
        : error instanceof AssistantConflictError ? 409 : 400;
      const code = status === 404 ? 'not_found' : status === 409 ? 'conflict' : 'invalid_request';
      sendError(res, status, code, message);
    }
  }
  return true;
}
