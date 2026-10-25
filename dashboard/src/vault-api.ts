import { z } from 'zod';
import {
  AssistantErrorResponseSchema,
  VaultGraphSchema,
  VaultNoteDetailSchema,
  VaultNoteListResponseSchema,
  VaultNoteSchema,
  VaultRenameResultSchema,
  VaultResolveResponseSchema,
  VaultReviewSchema,
  VaultRevisionListResponseSchema,
  VaultRevisionSchema,
  VaultSearchResultSchema,
  VaultStatsSchema,
  VaultTreeResponseSchema,
  type VaultGraph,
  type VaultLocalGraphDepth,
  type VaultNote,
  type VaultNoteDetail,
  type VaultNotePatch,
  type VaultNoteSummary,
  type VaultRenameResult,
  type VaultReview,
  type VaultRevision,
  type VaultRevisionSummary,
  type VaultSearchResult,
  type VaultStats,
  type VaultFolder,
} from '@siftkit/contracts';

const BASE = '/assistant/vault';

/** A failed vault request; `code` is the server's error code (`conflict`, `title_taken`, `not_found`, …). */
export class VaultRequestError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function send(path: string, token: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init?.body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
  });
  if (response.ok) return response;
  const parsed = AssistantErrorResponseSchema.safeParse(await response.json().catch(() => null));
  // Never reflect an unrecognised body into the UI; keep the status-only message.
  if (!parsed.success) throw new VaultRequestError(response.status, 'http_error', `Vault request failed (${response.status}).`);
  throw new VaultRequestError(response.status, parsed.data.error.code, parsed.data.error.message);
}

async function request<S extends z.ZodTypeAny>(path: string, token: string, schema: S, init?: RequestInit): Promise<z.infer<S>> {
  return schema.parse(await (await send(path, token, init)).json());
}

const noteId = (id: string) => `/notes/${encodeURIComponent(id)}`;
const json = (method: 'POST' | 'PUT', body: object): RequestInit => ({ method, body: JSON.stringify(body) });

export async function getVaultTree(token: string, stubs: boolean): Promise<VaultFolder[]> {
  return (await request(`/tree?stubs=${stubs}`, token, VaultTreeResponseSchema)).folders;
}

export async function listVaultNotes(token: string, folder: string, stubs: boolean, limit: number): Promise<VaultNoteSummary[]> {
  const query = new URLSearchParams({ folder, stubs: String(stubs), limit: String(limit) });
  return (await request(`/notes?${query}`, token, VaultNoteListResponseSchema)).notes;
}

export function getVaultNote(token: string, id: string): Promise<VaultNoteDetail> {
  return request(noteId(id), token, VaultNoteDetailSchema);
}

export async function resolveVaultTitle(token: string, title: string): Promise<string | null> {
  return (await request(`/resolve?${new URLSearchParams({ title })}`, token, VaultResolveResponseSchema)).id;
}

export function createVaultNote(token: string, title: string): Promise<VaultNote> {
  return request('/notes', token, VaultNoteSchema, json('POST', { title }));
}

export function updateVaultNote(token: string, id: string, patch: VaultNotePatch, expectedRevision: number): Promise<VaultNote> {
  return request(noteId(id), token, VaultNoteSchema, json('PUT', { ...patch, expectedRevision }));
}

export function renameVaultNote(token: string, id: string, title: string, expectedRevision: number): Promise<VaultRenameResult> {
  return request(`${noteId(id)}/rename`, token, VaultRenameResultSchema, json('POST', { title, expectedRevision }));
}

export async function listVaultRevisions(token: string, id: string): Promise<VaultRevisionSummary[]> {
  return (await request(`${noteId(id)}/revisions`, token, VaultRevisionListResponseSchema)).revisions;
}

export function getVaultRevision(token: string, id: string, revision: number): Promise<VaultRevision> {
  return request(`${noteId(id)}/revisions/${revision}`, token, VaultRevisionSchema);
}

export function restoreVaultRevision(token: string, id: string, revision: number, expectedRevision: number): Promise<VaultNote> {
  return request(`${noteId(id)}/restore`, token, VaultNoteSchema, json('POST', { revision, expectedRevision }));
}

export function searchVault(token: string, q: string, limit: number): Promise<VaultSearchResult> {
  return request(`/search?${new URLSearchParams({ q, limit: String(limit) })}`, token, VaultSearchResultSchema);
}

export function getVaultGraph(token: string): Promise<VaultGraph> {
  return request('/graph', token, VaultGraphSchema);
}

export function getVaultLocalGraph(token: string, id: string, depth: VaultLocalGraphDepth): Promise<VaultGraph> {
  return request(`/graph/local/${encodeURIComponent(id)}?depth=${depth}`, token, VaultGraphSchema);
}

export function getVaultReview(token: string, limit: number): Promise<VaultReview> {
  return request(`/review?limit=${limit}`, token, VaultReviewSchema);
}

export function getVaultStats(token: string): Promise<VaultStats> {
  return request('/stats', token, VaultStatsSchema);
}

/** An embed's bytes; `target` is the embed path (`attachments/captures/<id>.png`). A removed file rejects with status 404. */
export async function fetchVaultAttachment(token: string, target: string): Promise<Blob> {
  const relativePath = target.replace(/^attachments\//u, '').split('/').map(encodeURIComponent).join('/');
  return (await send(`/attachments/${relativePath}`, token)).blob();
}

/** The export is a zip archive, so it bypasses the JSON parse in `request`. */
export async function exportVaultArchive(token: string): Promise<Blob> {
  return (await send('/export', token, { method: 'POST' })).blob();
}
