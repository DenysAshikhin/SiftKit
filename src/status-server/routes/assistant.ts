import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  AssistantConfigPatchRequestSchema,
  AssistantConfirmTokenRequestSchema,
  AssistantDestructiveRequestSchema,
  AssistantExportRequestSchema,
  AssistantMutationRequestSchema,
  AssistantRestoreConfirmRequestSchema,
  AssistantTopicForgetRequestSchema,
  ActivityEventDtoSchema,
  AssistantValidationNotesRequestSchema,
  CaptureSubmissionDtoSchema,
  EnvironmentStateDtoSchema,
  KeyMaterialDtoSchema,
  MobileEnvelopeSchema,
  SIFT_MAX_IMAGE_BYTES,
  SuppressionAuditDtoSchema,
} from '@siftkit/contracts';
import { z } from '../../lib/zod.js';
import { ObjectValueTypeSchema } from '../../assistant/domain/enums.js';
import { JsonValueSchema } from '../../lib/json-types.js';
import type { AssistantService, DesktopPayloadKind } from '../../assistant/assistant-service.js';
import { AssistantConflictError, AssistantNotFoundError } from '../../assistant/errors.js';
import {
  RequestBodyTooLargeError, parseJsonBody, readBody, readBodyBytes, sendJson,
} from '../http-utils.js';
import { readConfig, writeConfig } from '../config-store.js';
import { RouteTable, type RouteEndpoint, type RouteMatch } from '../route-table.js';
import type { ServerContext } from '../server-types.js';

const MUTATION_BODY_LIMIT = 256 * 1024;
const QUESTION_ANSWER_BODY_LIMIT = 64 * 1024;
const KEY_MATERIAL_BODY_LIMIT = 64 * 1024;
const OBSERVATION_BODY_LIMIT = 16 * 1024;
/** A restore upload is a whole backup: database snapshot plus the entire encrypted blob tree. */
const RESTORE_BODY_LIMIT = 512 * 1024 * 1024;
/** A capture carries one max-size image as base64 (4 characters per 3 bytes), plus a descriptor. */
const CAPTURE_BODY_LIMIT =
  Math.ceil((SIFT_MAX_IMAGE_BYTES * 4) / 3) + OBSERVATION_BODY_LIMIT;

const CorrectionSchema = z.object({
  reason: z.string().trim().min(1),
  object: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('node'), nodeId: z.string() }).strict(),
    z.object({
      kind: z.literal('literal'), valueType: ObjectValueTypeSchema, value: JsonValueSchema,
    }).strict(),
  ]),
  objectText: z.string().trim().min(1),
}).strict();
const PinSchema = z.object({
  reason: z.string().trim().min(1),
  pinned: z.boolean(),
}).strict();
const AnswerSchema = z.object({ answer: z.string() }).strict();
const QuestionIdSchema = z.object({ questionId: z.string().trim().min(1) }).strict();
const SnoozeSchema = z.object({ eligibleAfterUtc: z.string() }).strict();
const PolicyPatchSchema = z.object({ enabled: z.boolean() }).strict();
const BlockPolicyTopicSchema = z.object({ topic: z.string().trim().min(1) }).strict();

function header(req: IncomingMessage, name: string): string | null {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function sendError(res: ServerResponse, status: number, code: string, message: string): void {
  sendJson(res, status, { error: { code, message } });
}

function id(match: RouteMatch): string {
  const value = match.captures[0];
  if (value === undefined) throw new Error('Assistant route did not capture an ID.');
  return decodeURIComponent(value);
}

function integerParam(url: URL, name: string, fallback: number): number {
  const raw = url.searchParams.get(name);
  if (raw === null) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) throw new Error(`${name} must be an integer.`);
  return parsed;
}

async function body<T>(
  req: IncomingMessage,
  schema: z.ZodType<T>,
  maxBytes = MUTATION_BODY_LIMIT,
): Promise<T> {
  return schema.parse(parseJsonBody(await readBody(req, { maxBytes })));
}

function success(service: AssistantService): { ok: true; graphVersion: number } {
  return { ok: true, graphVersion: service.graph.graphVersion };
}

/** Archive responses are streamed straight from memory and never cached to disk (§16.3). */
function sendZip(res: ServerResponse, bytes: Buffer): void {
  res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Length': bytes.byteLength,
    'Cache-Control': 'no-store',
  });
  res.end(bytes);
}

/**
 * Parses a desktop-shell payload. A contract mismatch is audited by kind alone and then rejected —
 * the body itself may hold key material or window titles and must never reach the audit row.
 */
async function desktopBody<T>(
  service: AssistantService,
  req: IncomingMessage,
  schema: z.ZodType<T>,
  kind: DesktopPayloadKind,
  maxBytes: number,
): Promise<T> {
  const result = schema.safeParse(parseJsonBody(await readBody(req, { maxBytes })));
  if (!result.success) {
    service.recordDesktopContractRejection(kind);
    throw new Error(`Desktop ${kind} payload does not match the supported contract version.`);
  }
  return result.data;
}

class AssistantEndpoint implements RouteEndpoint {
  async handle(
    ctx: ServerContext,
    req: IncomingMessage,
    res: ServerResponse,
    match: RouteMatch,
  ): Promise<void> {
    const service = ctx.assistantControl;
    if (service === null) {
      sendError(res, 503, 'assistant_unavailable', 'Assistant service is unavailable.');
      return;
    }
    const pathname = match.pathname;
    const method = req.method ?? 'GET';
    if (pathname === '/assistant/status') {
      sendJson(res, 200, service.status());
      return;
    }
    if (pathname === '/assistant/config') {
      if (method === 'GET') {
        sendJson(res, 200, { assistant: service.config });
        return;
      }
      const request = await body(req, AssistantConfigPatchRequestSchema);
      const config = readConfig(ctx.configPath);
      const updated = { ...config, Assistant: request.assistant };
      writeConfig(ctx.configPath, updated);
      service.refreshConfig(request.assistant);
      sendJson(res, 200, { assistant: service.config });
      return;
    }
    // Key custody deliberately sits ahead of the `enabled` gate (design §3): the shell migrates on
    // first connect and re-imports after every daemon restart, and both must work while the
    // assistant is off — otherwise custody is `'desktop'` with no key and evidence is unreadable.
    // Private mode gates observation, not key management, so it does not apply here either.
    if (pathname === '/assistant/keys/custody') {
      sendJson(res, 200, service.keyCustody.statusDto());
      return;
    }
    if (pathname === '/assistant/keys/export') {
      sendJson(res, 200, service.keyCustody.exportForShell());
      return;
    }
    if (pathname === '/assistant/keys/import') {
      const material = await desktopBody(
        service, req, KeyMaterialDtoSchema, 'key_material', KEY_MATERIAL_BODY_LIMIT,
      );
      service.keyCustody.importFromShell(material);
      sendJson(res, 200, service.keyCustody.statusDto());
      return;
    }
    // The tray drives its off/paused/attention states from this poll, so it must answer while
    // the assistant is disabled (spec §6). Read-only: a poll never transitions a question.
    if (pathname === '/assistant/desktop/state') {
      sendJson(res, 200, service.desktopState());
      return;
    }
    // §16 maintenance sits ahead of the `enabled` gate for the same reason key custody does:
    // turning the assistant off must never strand a user who wants their data erased, taken
    // with them, or put back.
    if (pathname === '/assistant/factory-reset/preview') {
      sendJson(res, 200, service.previewFactoryReset());
      return;
    }
    if (pathname === '/assistant/factory-reset') {
      const request = await body(req, AssistantConfirmTokenRequestSchema);
      // `factoryReset` serializes itself against drains; do not wrap it again here.
      await service.factoryReset(request.previewToken);
      sendJson(res, 200, { ok: true });
      return;
    }
    if (pathname === '/assistant/export') {
      const request = await body(req, AssistantExportRequestSchema);
      sendZip(res, await service.exports.export(request));
      return;
    }
    if (pathname === '/assistant/backup') {
      sendZip(res, await service.backups.createBackup());
      return;
    }
    if (pathname === '/assistant/restore-preview') {
      sendJson(res, 200, service.previewRestore(
        await readBodyBytes(req, { maxBytes: RESTORE_BODY_LIMIT }),
      ));
      return;
    }
    if (pathname === '/assistant/restore') {
      const request = await body(req, AssistantRestoreConfirmRequestSchema);
      sendJson(res, 200, await service.restore(request.uploadId, request.confirmToken));
      return;
    }
    // §7.6: while the flag is off the mobile route is indistinguishable from absent, which is
    // why this is decided before the enabled gate can answer with a reason.
    if (pathname === '/assistant/ingest/mobile' && !service.config.Mobile.Enabled) {
      sendError(res, 404, 'not_found', 'Not found.');
      return;
    }
    if (!service.enabled) {
      sendError(res, 409, 'assistant_disabled', 'Assistant is disabled.');
      return;
    }

    if (pathname === '/assistant/ingest/mobile') {
      const envelope = await body(req, MobileEnvelopeSchema);
      const verdict = service.ingestMobileEnvelope(envelope);
      if (verdict.kind === 'rejected') {
        sendError(res, 403, 'envelope_rejected', `Envelope rejected: ${verdict.reason}.`);
      } else {
        sendJson(res, 202, { ok: true });
      }
      return;
    }

    if (pathname === '/assistant/questions/mark-shown') {
      const request = await body(req, QuestionIdSchema, QUESTION_ANSWER_BODY_LIMIT);
      service.markQuestionShown(request.questionId);
      sendJson(res, 200, success(service));
      return;
    }
    if (pathname === '/assistant/questions/dismiss') {
      const request = await body(req, QuestionIdSchema, QUESTION_ANSWER_BODY_LIMIT);
      service.dismissQuestion(request.questionId);
      sendJson(res, 200, success(service));
      return;
    }

    if (pathname === '/assistant/ingest/environment') {
      service.ingestEnvironment(await desktopBody(
        service, req, EnvironmentStateDtoSchema, 'environment_state', OBSERVATION_BODY_LIMIT,
      ));
      sendJson(res, 200, { ok: true });
      return;
    }
    if (pathname === '/assistant/ingest/activity') {
      service.ingestActivity(await desktopBody(
        service, req, ActivityEventDtoSchema, 'activity_event', OBSERVATION_BODY_LIMIT,
      ));
      sendJson(res, 200, { ok: true });
      return;
    }
    if (pathname === '/assistant/ingest/capture') {
      const outcome = service.ingestCapture(await desktopBody(
        service, req, CaptureSubmissionDtoSchema, 'capture_submission', CAPTURE_BODY_LIMIT,
      ));
      sendJson(res, 200, { ok: true, outcome: outcome.kind });
      return;
    }
    if (pathname === '/assistant/ingest/suppression') {
      service.ingestSuppression(await desktopBody(
        service, req, SuppressionAuditDtoSchema, 'suppression_audit', OBSERVATION_BODY_LIMIT,
      ));
      sendJson(res, 200, { ok: true });
      return;
    }

    const url = new URL(req.url ?? pathname, 'http://127.0.0.1');
    if (pathname === '/assistant/search') {
      const result = service.memoryQueries.search(
        service.ownerId, url.searchParams.get('q') ?? '', integerParam(url, 'limit', 50),
      );
      sendJson(res, 200, {
        nodes: result.nodes.map((row) => ({ ...row })),
        assertions: result.assertions.map((row) => ({ ...row })),
        projections: result.projections.map((row) => ({ ...row })),
      });
      return;
    }
    if (pathname === '/assistant/graph/nodes') {
      sendJson(res, 200, { items: service.memoryQueries.listNodes(service.ownerId, {
        limit: integerParam(url, 'limit', 50), offset: integerParam(url, 'offset', 0),
      }) });
      return;
    }
    if (/^\/assistant\/graph\/nodes\/[^/]+\/neighborhood$/u.test(pathname)) {
      this.sendQueryResult(res, service.memoryQueries.getNeighborhood(
        service.ownerId, id(match), integerParam(url, 'maxHops', 2),
      ));
      return;
    }
    if (/^\/assistant\/graph\/nodes\/[^/]+$/u.test(pathname)) {
      this.sendQueryResult(res, service.memoryQueries.getNode(service.ownerId, id(match)));
      return;
    }
    if (pathname === '/assistant/graph/assertions') {
      sendJson(res, 200, { items: service.memoryQueries.listAssertions(service.ownerId, {
        limit: integerParam(url, 'limit', 50), offset: integerParam(url, 'offset', 0),
      }) });
      return;
    }
    if (/^\/assistant\/graph\/assertions\/[^/]+\/explanation$/u.test(pathname)) {
      this.sendQueryResult(
        res, service.memoryQueries.explainAssertion(service.ownerId, id(match)),
      );
      return;
    }
    if (/^\/assistant\/graph\/assertions\/[^/]+$/u.test(pathname) && method === 'GET') {
      this.sendQueryResult(res, service.memoryQueries.getAssertion(service.ownerId, id(match)));
      return;
    }
    if (pathname.endsWith('/confirm')) {
      const request = await body(req, AssistantMutationRequestSchema);
      service.memoryMutations.confirm({ ownerId: service.ownerId,
        assertionId: id(match), reason: request.reason });
      sendJson(res, 200, success(service));
      return;
    }
    if (pathname.endsWith('/correct')) {
      const request = await body(req, CorrectionSchema);
      service.memoryMutations.correct({
        ownerId: service.ownerId, assertionId: id(match), reason: request.reason,
        object: request.object, objectText: request.objectText,
      });
      sendJson(res, 200, success(service));
      return;
    }
    if (pathname.endsWith('/pin')) {
      const request = await body(req, PinSchema);
      service.memoryMutations.setPinned({
        ownerId: service.ownerId, assertionId: id(match), reason: request.reason,
        pinned: request.pinned,
      });
      sendJson(res, 200, success(service));
      return;
    }
    if (pathname.endsWith('/demote')) {
      const request = await body(req, AssistantMutationRequestSchema);
      service.memoryMutations.demote({
        ownerId: service.ownerId, assertionId: id(match), reason: request.reason,
      });
      sendJson(res, 200, success(service));
      return;
    }
    if (/^\/assistant\/graph\/assertions\/[^/]+$/u.test(pathname) && method === 'DELETE') {
      const request = await body(req, AssistantDestructiveRequestSchema);
      const assertionId = id(match);
      if (request.mode === 'preview') {
        sendJson(res, 200, service.memoryMutations.previewForgetAssertion(
          service.ownerId, assertionId,
        ));
      } else {
        service.memoryMutations.confirmForgetAssertion(
          service.ownerId, assertionId, request.previewToken,
        );
        sendJson(res, 200, success(service));
      }
      return;
    }
    if (pathname === '/assistant/evidence/blob') {
      try {
        const pixels = service.readEvidencePixels(url.searchParams.get('id') ?? '');
        // Decrypt-and-serve only: nothing on disk, nothing cacheable (spec §6).
        res.writeHead(200, {
          'Content-Type': pixels.mimeType,
          'Content-Length': pixels.bytes.byteLength,
          'Cache-Control': 'no-store',
        });
        res.end(pixels.bytes);
      } catch (error) {
        if (error instanceof AssistantNotFoundError) {
          sendError(res, 404, 'not_found', 'Evidence pixels are not available.');
        } else {
          sendError(
            res, 500, 'evidence_unreadable',
            error instanceof Error ? error.message : String(error),
          );
        }
      }
      return;
    }
    if (pathname === '/assistant/evidence') {
      sendJson(res, 200, { items: service.memoryQueries.listEvidence(service.ownerId, {
        limit: integerParam(url, 'limit', 50), offset: integerParam(url, 'offset', 0),
      }) });
      return;
    }
    if (/^\/assistant\/evidence\/[^/]+\/deletion-preview$/u.test(pathname)) {
      sendJson(res, 200, service.memoryMutations.previewDeleteEvidence(service.ownerId, id(match)));
      return;
    }
    if (/^\/assistant\/evidence\/[^/]+$/u.test(pathname) && method === 'DELETE') {
      const request = await body(req, AssistantConfirmTokenRequestSchema);
      service.memoryMutations.confirmDeleteEvidence(
        service.ownerId, id(match), request.previewToken,
      );
      sendJson(res, 200, success(service));
      return;
    }
    if (/^\/assistant\/evidence\/[^/]+$/u.test(pathname)) {
      this.sendQueryResult(
        res, service.memoryQueries.getEvidenceMetadata(service.ownerId, id(match)),
      );
      return;
    }
    if (pathname === '/assistant/topics/forget-preview') {
      const request = await body(req, z.object({ topicKey: z.string().trim().min(1) }).strict());
      sendJson(
        res, 200, service.memoryMutations.previewForgetTopic(service.ownerId, request.topicKey),
      );
      return;
    }
    if (pathname === '/assistant/topics/forget') {
      const request = await body(req, AssistantTopicForgetRequestSchema);
      service.memoryMutations.confirmForgetTopic(service.ownerId, request);
      sendJson(res, 200, success(service));
      return;
    }
    if (pathname === '/assistant/projections' && method === 'GET') {
      sendJson(res, 200, { items: service.memoryQueries.listProjections(service.ownerId) });
      return;
    }
    if (pathname === '/assistant/projections/rebuild') {
      await service.memoryMutations.rebuildProjections(
        service.ownerId, new AbortController().signal,
      );
      sendJson(res, 200, success(service));
      return;
    }
    if (pathname === '/assistant/questions/current') {
      sendJson(res, 200, { question: service.currentQuestion() });
      return;
    }
    if (pathname.endsWith('/answer')) {
      const request = await body(req, AnswerSchema, QUESTION_ANSWER_BODY_LIMIT);
      sendJson(res, 200, service.questionFeedback.answer({
        ownerId: service.ownerId, questionId: id(match), answer: request.answer,
      }));
      return;
    }
    if (pathname.endsWith('/skip')) {
      service.questionFeedback.skip(service.ownerId, id(match));
      sendJson(res, 200, success(service));
      return;
    }
    if (pathname.endsWith('/snooze')) {
      const request = await body(req, SnoozeSchema);
      service.questionFeedback.snooze(service.ownerId, id(match), request.eligibleAfterUtc);
      sendJson(res, 200, success(service));
      return;
    }
    if (pathname.endsWith('/do-not-repeat')) {
      service.questionFeedback.doNotRepeat(service.ownerId, id(match));
      sendJson(res, 200, success(service));
      return;
    }
    if (pathname.endsWith('/block-topic')) {
      service.questionFeedback.blockTopic(service.ownerId, id(match));
      sendJson(res, 200, success(service));
      return;
    }
    if (pathname === '/assistant/policies') {
      sendJson(res, 200, { items: service.listPolicies() });
      return;
    }
    if (pathname === '/assistant/policies/block-topic') {
      const request = await body(req, BlockPolicyTopicSchema);
      service.blockPolicyTopic(request.topic);
      sendJson(res, 200, success(service));
      return;
    }
    if (/^\/assistant\/policies\/[^/]+$/u.test(pathname)) {
      const policyId = id(match);
      const found = method === 'PATCH'
        ? service.setPolicyEnabled(policyId, (await body(req, PolicyPatchSchema)).enabled)
        : service.deletePolicy(policyId);
      if (!found) sendError(res, 404, 'not_found', 'Policy was not found.');
      else sendJson(res, 200, success(service));
      return;
    }
    if (pathname === '/assistant/validation') {
      sendJson(res, 200, { items: service.listValidationQueue() });
      return;
    }
    if (pathname.endsWith('/notes')) {
      const request = await body(req, AssistantValidationNotesRequestSchema);
      if (!service.setValidationNotes(id(match), request.notes)) {
        sendError(res, 404, 'not_found', 'Validation candidate was not found.');
      } else sendJson(res, 200, success(service));
      return;
    }
    if (/^\/assistant\/validation\/[^/]+$/u.test(pathname)) {
      if (!service.removeValidationCandidate(id(match))) {
        sendError(res, 404, 'not_found', 'Validation candidate was not found.');
      } else sendJson(res, 200, success(service));
      return;
    }
    if (pathname === '/assistant/history') {
      sendJson(res, 200, { items: service.memoryQueries.listMemoryHistory(service.ownerId) });
    }
  }

  private sendQueryResult(
    res: ServerResponse,
    result: { readonly kind: 'found'; readonly value: object } | { readonly kind: 'not_found' },
  ): void {
    if (result.kind === 'not_found') {
      sendError(res, 404, 'not_found', 'Assistant resource was not found.');
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result.value));
    }
  }
}

const endpoint = new AssistantEndpoint();
const routes = new RouteTable([
  { method: 'GET', path: '/assistant/status', endpoint },
  { method: 'GET', path: '/assistant/config', endpoint },
  { method: 'PATCH', path: '/assistant/config', endpoint },
  { method: 'GET', path: '/assistant/keys/custody', endpoint },
  { method: 'POST', path: '/assistant/keys/export', endpoint },
  { method: 'POST', path: '/assistant/keys/import', endpoint },
  { method: 'POST', path: '/assistant/ingest/environment', endpoint },
  { method: 'POST', path: '/assistant/ingest/activity', endpoint },
  { method: 'POST', path: '/assistant/ingest/capture', endpoint },
  { method: 'POST', path: '/assistant/ingest/suppression', endpoint },
  { method: 'GET', path: '/assistant/search', endpoint },
  { method: 'GET', path: '/assistant/graph/nodes', endpoint },
  { method: 'GET', path: /^\/assistant\/graph\/nodes\/([^/]+)$/u, endpoint },
  { method: 'GET', path: /^\/assistant\/graph\/nodes\/([^/]+)\/neighborhood$/u, endpoint },
  { method: 'GET', path: '/assistant/graph/assertions', endpoint },
  { method: 'GET', path: /^\/assistant\/graph\/assertions\/([^/]+)$/u, endpoint },
  { method: 'GET', path: /^\/assistant\/graph\/assertions\/([^/]+)\/explanation$/u, endpoint },
  { method: 'POST', path: /^\/assistant\/graph\/assertions\/([^/]+)\/confirm$/u, endpoint },
  { method: 'POST', path: /^\/assistant\/graph\/assertions\/([^/]+)\/correct$/u, endpoint },
  { method: 'POST', path: /^\/assistant\/graph\/assertions\/([^/]+)\/pin$/u, endpoint },
  { method: 'POST', path: /^\/assistant\/graph\/assertions\/([^/]+)\/demote$/u, endpoint },
  { method: 'DELETE', path: /^\/assistant\/graph\/assertions\/([^/]+)$/u, endpoint },
  { method: 'GET', path: '/assistant/evidence', endpoint },
  { method: 'GET', path: '/assistant/evidence/blob', endpoint },
  // Ahead of the bare evidence-id route, matching the blob-route ordering above.
  { method: 'GET', path: /^\/assistant\/evidence\/([^/]+)\/deletion-preview$/u, endpoint },
  { method: 'DELETE', path: /^\/assistant\/evidence\/([^/]+)$/u, endpoint },
  { method: 'GET', path: /^\/assistant\/evidence\/([^/]+)$/u, endpoint },
  { method: 'POST', path: '/assistant/topics/forget-preview', endpoint },
  { method: 'POST', path: '/assistant/topics/forget', endpoint },
  { method: 'GET', path: '/assistant/factory-reset/preview', endpoint },
  { method: 'POST', path: '/assistant/factory-reset', endpoint },
  { method: 'POST', path: '/assistant/export', endpoint },
  { method: 'POST', path: '/assistant/backup', endpoint },
  { method: 'POST', path: '/assistant/restore-preview', endpoint },
  { method: 'POST', path: '/assistant/restore', endpoint },
  { method: 'POST', path: '/assistant/ingest/mobile', endpoint },
  { method: 'GET', path: '/assistant/projections', endpoint },
  { method: 'POST', path: '/assistant/projections/rebuild', endpoint },
  { method: 'GET', path: '/assistant/desktop/state', endpoint },
  { method: 'GET', path: '/assistant/questions/current', endpoint },
  { method: 'POST', path: '/assistant/questions/mark-shown', endpoint },
  { method: 'POST', path: '/assistant/questions/dismiss', endpoint },
  { method: 'POST', path: /^\/assistant\/questions\/([^/]+)\/answer$/u, endpoint },
  { method: 'POST', path: /^\/assistant\/questions\/([^/]+)\/skip$/u, endpoint },
  { method: 'POST', path: /^\/assistant\/questions\/([^/]+)\/snooze$/u, endpoint },
  { method: 'POST', path: /^\/assistant\/questions\/([^/]+)\/do-not-repeat$/u, endpoint },
  { method: 'POST', path: /^\/assistant\/questions\/([^/]+)\/block-topic$/u, endpoint },
  { method: 'GET', path: '/assistant/policies', endpoint },
  { method: 'POST', path: '/assistant/policies/block-topic', endpoint },
  { method: 'PATCH', path: /^\/assistant\/policies\/([^/]+)$/u, endpoint },
  { method: 'DELETE', path: /^\/assistant\/policies\/([^/]+)$/u, endpoint },
  { method: 'GET', path: '/assistant/validation', endpoint },
  { method: 'PATCH', path: /^\/assistant\/validation\/([^/]+)\/notes$/u, endpoint },
  { method: 'DELETE', path: /^\/assistant\/validation\/([^/]+)$/u, endpoint },
  { method: 'GET', path: '/assistant/history', endpoint },
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
