import { randomUUID } from 'node:crypto';
import {
  getRuntimeArtifactUri,
  readRuntimeArtifact,
  upsertRuntimeTextArtifact,
} from '../state/runtime-artifacts.js';
import { createTracer } from '../lib/trace.js';
import type { JsonSerializable } from '../lib/json-types.js';
import type { JsonLogger } from './types.js';

export const traceRepoSearch = createTracer('SIFTKIT_TRACE_REPO_SEARCH', 'repo-search');

export type BufferedJsonLogger = JsonLogger & {
  getText: () => string;
  persist: (targetPath: string, requestId?: string | null) => string;
};

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

export function createJsonLogger(logPath: string): BufferedJsonLogger {
  const lines: string[] = [];
  let persistedArtifactId: string | null = null;
  const getText = (): string => lines.join('');
  const persist = (targetPath: string, requestId?: string | null): string => {
    const targetId = persistedArtifactId || randomUUID();
    const existing = readRuntimeArtifact(targetId);
    upsertRuntimeTextArtifact({
      id: targetId,
      artifactKind: existing?.artifactKind || 'repo_search_transcript',
      requestId: requestId ?? existing?.requestId ?? null,
      title: targetPath,
      content: getText(),
    });
    persistedArtifactId = targetId;
    return getRuntimeArtifactUri(targetId);
  };
  return {
    path: logPath,
    write(event: Record<string, JsonSerializable>): void {
      lines.push(`${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
    },
    getText,
    persist,
  };
}
