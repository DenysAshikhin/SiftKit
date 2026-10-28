import {
  VaultCreateNoteRequestSchema, VaultDeleteRequestSchema, VaultGraphQuerySchema, VaultLocalGraphQuerySchema,
  VaultNoteListQuerySchema, VaultRenameRequestSchema, VaultResolveQuerySchema, VaultRestoreRequestSchema,
  VaultReviewQuerySchema, VaultRevisionNumberSchema, VAULT_LOCAL_GRAPH_CAP, VaultSearchQuerySchema, VaultTreeQuerySchema, VaultTriageRequestSchema,
  VaultUpdateNoteRequestSchema,
  type VaultDeleteResponse, type VaultNoteListResponse, type VaultResolveResponse, type VaultRevisionListResponse,
  type VaultTreeResponse, type VaultWriteMeta, type VaultWriteSource,
} from '@siftkit/contracts';
import { z } from '../../../lib/zod.ts';
import { exportVault } from '../../../vault/vault-export.ts';
import { sendJson } from '../../http-utils.ts';
import type { RouteMatch } from '../../route-table.ts';
import {
  assistantRoute, body, id, queryParams, sendArchive,
} from './helpers.ts';

const YOU: VaultWriteSource = { actor: 'you', sourceRef: null };

const youMeta = (summary: string): VaultWriteMeta => ({ ...YOU, summary });
const revisionCapture = (match: RouteMatch): number => z.coerce.number().pipe(VaultRevisionNumberSchema).parse(match.captures[1]);

export const vaultTreeEndpoint = assistantRoute(({ service, res, url }) => {
  const query = queryParams(url, VaultTreeQuerySchema);
  sendJson(res, 200, { folders: service.vaultQueries.folders({ includeStubs: query.stubs }) } satisfies VaultTreeResponse);
});

export const vaultListNotesEndpoint = assistantRoute(({ service, res, url }) => {
  const query = queryParams(url, VaultNoteListQuerySchema);
  sendJson(res, 200, {
    notes: service.vaultQueries.folderNotes(query.folder, { includeStubs: query.stubs, limit: query.limit }),
  } satisfies VaultNoteListResponse);
});

export const vaultNoteDetailEndpoint = assistantRoute(({ service, res, match }) => {
  sendJson(res, 200, service.vaultQueries.detail(id(match)));
});

export const vaultResolveEndpoint = assistantRoute(({ service, res, url }) => {
  const query = queryParams(url, VaultResolveQuerySchema);
  sendJson(res, 200, { id: service.vaultNotes.resolveId(query.title) } satisfies VaultResolveResponse);
});

export const vaultCreateNoteEndpoint = assistantRoute(async ({ service, req, res }) => {
  sendJson(res, 200, service.vaultNotes.create(await body(req, VaultCreateNoteRequestSchema), youMeta('Created')));
});

export const vaultUpdateNoteEndpoint = assistantRoute(async ({ service, req, res, match }) => {
  const { expectedRevision, ...patch } = await body(req, VaultUpdateNoteRequestSchema);
  sendJson(res, 200, service.vaultNotes.update(id(match), patch, expectedRevision, youMeta('Edited')));
});

export const vaultRenameNoteEndpoint = assistantRoute(async ({ service, req, res, match }) => {
  const request = await body(req, VaultRenameRequestSchema);
  sendJson(res, 200, service.vaultNotes.rename(id(match), request.title, request.expectedRevision, YOU));
});

export const vaultDeleteNoteEndpoint = assistantRoute(async ({ service, req, res, match }) => {
  const request = await body(req, VaultDeleteRequestSchema);
  service.vaultNotes.delete(id(match), request.expectedRevision);
  sendJson(res, 200, { ok: true } satisfies VaultDeleteResponse);
});

export const vaultRevisionsEndpoint = assistantRoute(({ service, res, match }) => {
  sendJson(res, 200, { revisions: service.vaultNotes.listRevisions(id(match)) } satisfies VaultRevisionListResponse);
});

export const vaultRevisionEndpoint = assistantRoute(({ service, res, match }) => {
  sendJson(res, 200, service.vaultNotes.getRevision(id(match), revisionCapture(match)));
});

export const vaultRestoreEndpoint = assistantRoute(async ({ service, req, res, match }) => {
  const request = await body(req, VaultRestoreRequestSchema);
  sendJson(res, 200, service.vaultNotes.restore(id(match), request.revision, request.expectedRevision, YOU));
});

export const vaultTriageEndpoint = assistantRoute(async ({ service, req, res, match }) => {
  sendJson(res, 200, service.triageVaultFact(id(match), await body(req, VaultTriageRequestSchema)));
});

export const vaultSearchEndpoint = assistantRoute(({ service, res, url }) => {
  const query = queryParams(url, VaultSearchQuerySchema);
  sendJson(res, 200, service.vaultSearch.search(query.q, query.limit));
});

export const vaultGraphEndpoint = assistantRoute(({ service, res, url }) => {
  const query = queryParams(url, VaultGraphQuerySchema);
  sendJson(res, 200, service.vaultGraph.global({ minLinks: query.minLinks, hiddenTopFolders: query.hide }));
});

export const vaultLocalGraphEndpoint = assistantRoute(({ service, res, match, url }) => {
  const query = queryParams(url, VaultLocalGraphQuerySchema);
  sendJson(res, 200, service.vaultGraph.local(id(match), query.depth, VAULT_LOCAL_GRAPH_CAP));
});

export const vaultReviewEndpoint = assistantRoute(({ service, res, url }) => {
  sendJson(res, 200, service.vaultQueries.review(queryParams(url, VaultReviewQuerySchema).limit));
});

export const vaultStatsEndpoint = assistantRoute(({ service, res }) => {
  sendJson(res, 200, service.vaultStats());
});

export const vaultAttachmentEndpoint = assistantRoute(({ service, res, match }) => {
  const file = service.vaultAttachments.read(id(match));
  res.writeHead(200, { 'Content-Type': file.mimeType, 'Content-Length': file.bytes.byteLength, 'Cache-Control': 'no-store' });
  res.end(file.bytes);
});

/** Export stays reachable with the assistant off, like the legacy export: it is the user's own data. */
export const vaultExportEndpoint = assistantRoute(async ({ service, res }) => {
  await sendArchive(res, exportVault(service.vaultQueries.allNotes()));
}, { requireEnabled: false });
