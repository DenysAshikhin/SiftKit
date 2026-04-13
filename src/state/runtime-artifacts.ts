import { randomUUID } from 'node:crypto';
import type { Dict } from '../lib/types.js';
import { getRuntimeDatabase, type RuntimeDatabase } from './runtime-db.js';

export type RuntimeArtifactRecord = {
  id: string;
  artifactKind: string;
  requestId: string | null;
  title: string | null;
  contentText: string | null;
  contentJson: Dict | null;
  createdAtUtc: string;
  updatedAtUtc: string;
};

export function listRuntimeArtifacts(options: {
  artifactKind?: string;
  requestId?: string;
  limit?: number;
  databasePath?: string;
} = {}): RuntimeArtifactRecord[] {
  const database = getDatabase(options.databasePath);
  const limit = Number.isFinite(options.limit) ? Math.max(1, Math.trunc(Number(options.limit))) : 200;
  const artifactKind = String(options.artifactKind || '').trim();
  const requestId = String(options.requestId || '').trim();
  const rows = (
    artifactKind
      ? database.prepare(`
        SELECT id, artifact_kind, request_id, title, content_text, content_json, created_at_utc, updated_at_utc
        FROM runtime_artifacts
        WHERE artifact_kind = ?
          AND (? = '' OR request_id = ?)
        ORDER BY updated_at_utc DESC, id DESC
        LIMIT ?
      `).all(artifactKind, requestId, requestId, limit)
      : database.prepare(`
        SELECT id, artifact_kind, request_id, title, content_text, content_json, created_at_utc, updated_at_utc
        FROM runtime_artifacts
        WHERE (? = '' OR request_id = ?)
        ORDER BY updated_at_utc DESC, id DESC
        LIMIT ?
      `).all(requestId, requestId, limit)
  ) as Array<Record<string, unknown>>;
  return rows
    .map((row) => {
      const id = typeof row.id === 'string' ? row.id : '';
      return id ? readRuntimeArtifact(id, options.databasePath) : null;
    })
    .filter((entry): entry is RuntimeArtifactRecord => entry !== null);
}

export function deleteRuntimeArtifact(id: string, databasePath?: string): boolean {
  const artifactId = String(id || '').trim();
  if (!artifactId) {
    return false;
  }
  const database = getDatabase(databasePath);
  const result = database.prepare('DELETE FROM runtime_artifacts WHERE id = ?').run(artifactId);
  return Number(result.changes) > 0;
}

function normalizeKind(value: unknown): string {
  const kind = String(value || '').trim();
  return kind || 'artifact';
}

function getDatabase(databasePath?: string): RuntimeDatabase {
  return getRuntimeDatabase(databasePath);
}

export function getRuntimeArtifactUri(id: string): string {
  return `db://runtime-artifacts/${id}`;
}

export function parseRuntimeArtifactUri(uri: string): string | null {
  const text = String(uri || '').trim();
  if (!text.startsWith('db://runtime-artifacts/')) {
    return null;
  }
  const id = text.slice('db://runtime-artifacts/'.length).trim();
  return id || null;
}

export function upsertRuntimeTextArtifact(options: {
  id?: string;
  artifactKind: string;
  requestId?: string | null;
  title?: string | null;
  content: string;
  databasePath?: string;
}): { id: string; uri: string } {
  const id = options.id && options.id.trim() ? options.id.trim() : randomUUID();
  const now = new Date().toISOString();
  const database = getDatabase(options.databasePath);
  database.prepare(`
    INSERT INTO runtime_artifacts (
      id, artifact_kind, request_id, title, content_text, content_json, created_at_utc, updated_at_utc
    ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      artifact_kind = excluded.artifact_kind,
      request_id = excluded.request_id,
      title = excluded.title,
      content_text = excluded.content_text,
      updated_at_utc = excluded.updated_at_utc
  `).run(
    id,
    normalizeKind(options.artifactKind),
    options.requestId ?? null,
    options.title ?? null,
    String(options.content || ''),
    now,
    now,
  );
  return { id, uri: getRuntimeArtifactUri(id) };
}

export function appendRuntimeTextArtifact(options: {
  id: string;
  artifactKind: string;
  requestId?: string | null;
  title?: string | null;
  line: string;
  databasePath?: string;
}): { id: string; uri: string } {
  const existing = readRuntimeArtifact(options.id, options.databasePath);
  const baseText = existing?.contentText || '';
  const nextText = `${baseText}${String(options.line || '')}`;
  return upsertRuntimeTextArtifact({
    id: options.id,
    artifactKind: options.artifactKind,
    requestId: options.requestId ?? existing?.requestId ?? null,
    title: options.title ?? existing?.title ?? null,
    content: nextText,
    databasePath: options.databasePath,
  });
}

export function upsertRuntimeJsonArtifact(options: {
  id?: string;
  artifactKind: string;
  requestId?: string | null;
  title?: string | null;
  payload: Dict;
  databasePath?: string;
}): { id: string; uri: string } {
  const id = options.id && options.id.trim() ? options.id.trim() : randomUUID();
  const now = new Date().toISOString();
  const database = getDatabase(options.databasePath);
  database.prepare(`
    INSERT INTO runtime_artifacts (
      id, artifact_kind, request_id, title, content_text, content_json, created_at_utc, updated_at_utc
    ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      artifact_kind = excluded.artifact_kind,
      request_id = excluded.request_id,
      title = excluded.title,
      content_json = excluded.content_json,
      updated_at_utc = excluded.updated_at_utc
  `).run(
    id,
    normalizeKind(options.artifactKind),
    options.requestId ?? null,
    options.title ?? null,
    JSON.stringify(options.payload || {}),
    now,
    now,
  );
  return { id, uri: getRuntimeArtifactUri(id) };
}

export function readRuntimeArtifact(id: string, databasePath?: string): RuntimeArtifactRecord | null {
  const artifactId = String(id || '').trim();
  if (!artifactId) {
    return null;
  }
  const database = getDatabase(databasePath);
  const row = database.prepare(`
    SELECT id, artifact_kind, request_id, title, content_text, content_json, created_at_utc, updated_at_utc
    FROM runtime_artifacts
    WHERE id = ?
  `).get(artifactId) as Record<string, unknown> | undefined;
  if (!row) {
    return null;
  }
  let contentJson: Dict | null = null;
  if (typeof row.content_json === 'string' && row.content_json.trim()) {
    try {
      const parsed = JSON.parse(row.content_json) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        contentJson = parsed as Dict;
      }
    } catch {
      contentJson = null;
    }
  }
  return {
    id: String(row.id),
    artifactKind: String(row.artifact_kind),
    requestId: typeof row.request_id === 'string' ? row.request_id : null,
    title: typeof row.title === 'string' ? row.title : null,
    contentText: typeof row.content_text === 'string' ? row.content_text : null,
    contentJson,
    createdAtUtc: typeof row.created_at_utc === 'string' ? row.created_at_utc : new Date(0).toISOString(),
    updatedAtUtc: typeof row.updated_at_utc === 'string' ? row.updated_at_utc : new Date(0).toISOString(),
  };
}
