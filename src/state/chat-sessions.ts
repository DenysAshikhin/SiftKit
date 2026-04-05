import * as crypto from 'node:crypto';
import * as path from 'node:path';
import { listFiles, safeReadJson, saveContentAtomically } from '../status-server/http-utils.js';

type Dict = Record<string, unknown>;

export type ChatMessage = Dict;
export type ChatSession = Dict & { id: string; messages?: ChatMessage[]; hiddenToolContexts?: Dict[] };

export function estimateTokenCount(value: unknown): number {
  const text = String(value || '');
  if (!text.trim()) {
    return 0;
  }
  return Math.max(1, Math.ceil(text.length / 4));
}

export function getChatSessionsRoot(runtimeRoot: string): string {
  return path.join(runtimeRoot, 'chat', 'sessions');
}

export function listChatSessionPaths(runtimeRoot: string): string[] {
  return listFiles(getChatSessionsRoot(runtimeRoot))
    .filter((targetPath) => /^session_.+\.json$/iu.test(path.basename(targetPath)));
}

export function readChatSessionFromPath(targetPath: string): ChatSession | null {
  const payload = safeReadJson(targetPath);
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  if (typeof payload.id !== 'string' || !payload.id.trim()) {
    return null;
  }
  if (typeof payload.thinkingEnabled !== 'boolean') {
    payload.thinkingEnabled = true;
  }
  if (payload.mode !== 'plan') {
    payload.mode = 'chat';
  }
  if (typeof payload.planRepoRoot !== 'string' || !(payload.planRepoRoot as string).trim()) {
    payload.planRepoRoot = process.cwd();
  }
  if (!Array.isArray(payload.hiddenToolContexts)) {
    payload.hiddenToolContexts = [];
  } else {
    payload.hiddenToolContexts = (payload.hiddenToolContexts as unknown[])
      .filter((entry): entry is Dict => Boolean(entry) && typeof entry === 'object')
      .map((entry) => {
        const content = typeof entry.content === 'string' ? entry.content.trim() : '';
        if (!content) {
          return null;
        }
        const tokenEstimate = Number.isFinite(entry.tokenEstimate) && Number(entry.tokenEstimate) >= 0
          ? Number(entry.tokenEstimate)
          : estimateTokenCount(content);
        return {
          id: typeof entry.id === 'string' && entry.id.trim() ? entry.id : crypto.randomUUID(),
          content,
          tokenEstimate,
          sourceMessageId: typeof entry.sourceMessageId === 'string' && entry.sourceMessageId.trim()
            ? entry.sourceMessageId
            : null,
          createdAtUtc: typeof entry.createdAtUtc === 'string' && entry.createdAtUtc.trim()
            ? entry.createdAtUtc
            : new Date().toISOString(),
        } as Dict;
      })
      .filter((entry): entry is Dict => entry !== null);
  }
  return payload as ChatSession;
}

export function readChatSessions(runtimeRoot: string): ChatSession[] {
  return listChatSessionPaths(runtimeRoot)
    .map(readChatSessionFromPath)
    .filter((entry): entry is ChatSession => entry !== null)
    .sort((left, right) => String(right.updatedAtUtc || '').localeCompare(String(left.updatedAtUtc || '')));
}

export function getChatSessionPath(runtimeRoot: string, sessionId: string): string {
  return path.join(getChatSessionsRoot(runtimeRoot), `session_${sessionId}.json`);
}

export function saveChatSession(runtimeRoot: string, session: ChatSession): void {
  const targetPath = getChatSessionPath(runtimeRoot, session.id);
  saveContentAtomically(targetPath, `${JSON.stringify(session, null, 2)}\n`);
}
