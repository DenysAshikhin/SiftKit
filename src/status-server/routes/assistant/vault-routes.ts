import {
  VaultCreateNoteRequestSchema, VaultDeleteRequestSchema, VaultRenameRequestSchema, VaultRestoreRequestSchema,
  VaultUpdateNoteRequestSchema,
  type VaultDeleteResponse, type VaultNoteListResponse, type VaultResolveResponse, type VaultRevisionListResponse,
  type VaultTreeResponse, type VaultWriteMeta,
} from '@siftkit/contracts';
import { z } from '../../../lib/zod.ts';
import { exportVault } from '../../../vault/vault-export.ts';
import { sendJson } from '../../http-utils.ts';
import type { RouteMatch } from '../../route-table.ts';
import {
  assistantRoute, body, booleanParam, id, integerParam, sendArchive,
} from './helpers.ts';

const LOCAL_GRAPH_NODE_CAP = 160;
const LocalGraphDepthSchema = z.union([z.literal(1), z.literal(2)]);
const RevisionCaptureSchema = z.coerce.number().int().min(1);

const youMeta = (summary: string): VaultWriteMeta => ({ actor: 'you', summary, sourceRef: null });
const revisionCapture = (match: RouteMatch): number => RevisionCaptureSchema.parse(match.captures[1]);

export const vaultTreeEndpoint = assistantRoute(({ service, res, url }) => {
  const response: VaultTreeResponse = { folders: service.vaultQueries.folders({ includeStubs: booleanParam(url, 'stubs') }) };
  sendJson(res, 200, response);
});

export const vaultListNotesEndpoint = assistantRoute(({ service, res, url }) => {
  const response: VaultNoteListResponse = {
    notes: service.vaultQueries.folderNotes(url.searchParams.get('folder') ?? '', {
      includeStubs: booleanParam(url, 'stubs'), limit: integerParam(url, 'limit', 500),
    }),
  };
  sendJson(res, 200, response);
});

export const vaultNoteDetailEndpoint = assistantRoute(({ service, res, match }) => {
  sendJson(res, 200, service.vaultQueries.detail(id(match)));
});

export const vaultResolveEndpoint = assistantRoute(({ service, res, url }) => {
  const response: VaultResolveResponse = { id: service.vaultNotes.resolve(url.searchParams.get('title') ?? '')?.id ?? null };
  sendJson(res, 200, response);
});

export const vaultCreateNoteEndpoint = assistantRoute(async ({ service, req, res }) => {
  const request = await body(req, VaultCreateNoteRequestSchema);
  sendJson(res, 200, service.vaultNotes.create(
    { ...request, kind: 'note', types: [], aliases: [], tags: [] }, youMeta('Created'),
  ));
});

export const vaultUpdateNoteEndpoint = assistantRoute(async ({ service, req, res, match }) => {
  const { expectedRevision, ...patch } = await body(req, VaultUpdateNoteRequestSchema);
  sendJson(res, 200, service.vaultNotes.update(id(match), patch, expectedRevision, youMeta('Edited')));
});

export const vaultRenameNoteEndpoint = assistantRoute(async ({ service, req, res, match }) => {
  const request = await body(req, VaultRenameRequestSchema);
  sendJson(res, 200, service.vaultNotes.rename(id(match), request.title, request.expectedRevision, youMeta(`Renamed to ${request.title}`)));
});

export const vaultDeleteNoteEndpoint = assistantRoute(async ({ service, req, res, match }) => {
  const request = await body(req, VaultDeleteRequestSchema);
  service.vaultNotes.delete(id(match), request.expectedRevision);
  const response: VaultDeleteResponse = { ok: true };
  sendJson(res, 200, response);
});

export const vaultRevisionsEndpoint = assistantRoute(({ service, res, match }) => {
  const response: VaultRevisionListResponse = { revisions: service.vaultNotes.listRevisions(id(match)) };
  sendJson(res, 200, response);
});

export const vaultRevisionEndpoint = assistantRoute(({ service, res, match }) => {
  sendJson(res, 200, service.vaultNotes.getRevision(id(match), revisionCapture(match)));
});

export const vaultRestoreEndpoint = assistantRoute(async ({ service, req, res, match }) => {
  const request = await body(req, VaultRestoreRequestSchema);
  sendJson(res, 200, service.vaultNotes.restore(
    id(match), request.revision, request.expectedRevision, youMeta(`Restored revision ${request.revision}`),
  ));
});

export const vaultSearchEndpoint = assistantRoute(({ service, res, url }) => {
  sendJson(res, 200, service.vaultSearch.search(url.searchParams.get('q') ?? '', integerParam(url, 'limit', 50)));
});

export const vaultGraphEndpoint = assistantRoute(({ service, res, url }) => {
  const hidden = (url.searchParams.get('hide') ?? '').split(',').map((folder) => folder.trim()).filter((folder) => folder.length > 0);
  sendJson(res, 200, service.vaultGraph.global({ minLinks: integerParam(url, 'minLinks', 0), hiddenTopFolders: hidden }));
});

export const vaultLocalGraphEndpoint = assistantRoute(({ service, res, match, url }) => {
  const depth = LocalGraphDepthSchema.parse(integerParam(url, 'depth', 1));
  sendJson(res, 200, service.vaultGraph.local(id(match), depth, LOCAL_GRAPH_NODE_CAP));
});

export const vaultReviewEndpoint = assistantRoute(({ service, res, url }) => {
  sendJson(res, 200, service.vaultQueries.review(integerParam(url, 'limit', 200)));
});

export const vaultStatsEndpoint = assistantRoute(({ service, res }) => {
  sendJson(res, 200, service.vaultQueries.stats());
});

/** Export stays reachable with the assistant off, like the legacy export: it is the user's own data. */
export const vaultExportEndpoint = assistantRoute(async ({ service, res }) => {
  await sendArchive(res, exportVault(service.vaultQueries.allNotes()));
}, { requireEnabled: false });
