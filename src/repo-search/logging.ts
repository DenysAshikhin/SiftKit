import { randomUUID } from 'node:crypto';
import {
  getRuntimeArtifactUri,
  parseRuntimeArtifactUri,
  readRuntimeArtifact,
  upsertRuntimeTextArtifact,
} from '../state/runtime-artifacts.js';
import { createTracer } from '../lib/trace.js';
import type { JsonLogger } from './types.js';

export const traceRepoSearch = createTracer('SIFTKIT_TRACE_REPO_SEARCH', 'repo-search');

export type BufferedJsonLogger = JsonLogger & {
  getText: () => string;
  persist: (targetPath: string, requestId?: string | null) => string;
};

const logPathToArtifactId = new Map<string, string>();

function normalizeLogKey(value: string): string {
  return String(value || '').replace(/\\/gu, '/').trim();
}

function getArtifactIdForPath(logPath: string): string | null {
  const key = normalizeLogKey(logPath);
  if (!key) {
    return null;
  }
  const mappedId = logPathToArtifactId.get(key);
  if (mappedId) {
    return mappedId;
  }
  const fromUri = parseRuntimeArtifactUri(key);
  return fromUri || null;
}

function setArtifactIdForPath(logPath: string, artifactId: string): void {
  const key = normalizeLogKey(logPath);
  if (!key) {
    return;
  }
  logPathToArtifactId.set(key, artifactId);
}

export function ensureRepoSearchLogFolders(): {
  root: string;
  successful: string;
  failed: string;
} {
  return {
    root: 'db://repo-search',
    successful: 'db://repo-search/successful',
    failed: 'db://repo-search/failed',
  };
}

export function moveFileSafe(sourcePath: string, targetPath: string): void {
  const sourceId = getArtifactIdForPath(sourcePath);
  if (!sourceId) {
    return;
  }
  const sourceRecord = readRuntimeArtifact(sourceId);
  if (!sourceRecord) {
    return;
  }
  const targetId = getArtifactIdForPath(targetPath) || randomUUID();
  upsertRuntimeTextArtifact({
    id: targetId,
    artifactKind: sourceRecord.artifactKind || 'repo_search_transcript',
    requestId: sourceRecord.requestId,
    title: targetPath,
    content: sourceRecord.contentText || '',
  });
  setArtifactIdForPath(targetPath, targetId);
}

export function readJsonLog(logPath: string): string {
  const artifactId = getArtifactIdForPath(logPath);
  if (!artifactId) {
    return '';
  }
  const record = readRuntimeArtifact(artifactId);
  return record?.contentText || '';
}

export function createJsonLogger(logPath: string): BufferedJsonLogger {
  const lines: string[] = [];
  let persistedArtifactId: string | null = null;
  const getText = (): string => lines.join('');
  const persist = (targetPath: string, requestId?: string | null): string => {
    const targetId = getArtifactIdForPath(targetPath) || persistedArtifactId || randomUUID();
    const existing = readRuntimeArtifact(targetId);
    upsertRuntimeTextArtifact({
      id: targetId,
      artifactKind: existing?.artifactKind || 'repo_search_transcript',
      requestId: requestId ?? existing?.requestId ?? null,
      title: targetPath,
      content: getText(),
    });
    persistedArtifactId = targetId;
    setArtifactIdForPath(logPath, targetId);
    setArtifactIdForPath(targetPath, targetId);
    return getRuntimeArtifactUri(targetId);
  };
  return {
    path: logPath,
    write(event: Record<string, unknown>): void {
      lines.push(`${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
    },
    getText,
    persist,
  };
}

export function resolveRepoSearchLogUri(logPath: string): string {
  const artifactId = getArtifactIdForPath(logPath);
  return artifactId ? getRuntimeArtifactUri(artifactId) : logPath;
}
