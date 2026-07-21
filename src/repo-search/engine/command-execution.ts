import { spawnPowerShellAsync } from '../../lib/powershell.js';
import type { RepoSearchMockCommandResult } from '../types.js';
import { getAbortError, throwIfAborted } from './abort.js';

export function findMockResult(
  command: string,
  mockCommandResults: Record<string, RepoSearchMockCommandResult>,
): RepoSearchMockCommandResult | null {
  if (Object.prototype.hasOwnProperty.call(mockCommandResults, command)) {
    return mockCommandResults[command];
  }
  // Prefix match: find the longest mock key that the command starts with, so a
  // mock key can omit trailing arguments it does not care about.
  let bestKey: string | null = null;
  for (const key of Object.keys(mockCommandResults)) {
    if (command.startsWith(key) && (!bestKey || key.length > bestKey.length)) {
      bestKey = key;
    }
  }
  return bestKey ? mockCommandResults[bestKey] : null;
}

export function executeRepoCommand(
  command: string,
  repoRoot: string,
  mockCommandResults: Record<string, RepoSearchMockCommandResult> | null,
  abortSignal?: AbortSignal,
): Promise<{ exitCode: number; output: string }> {
  throwIfAborted(abortSignal);
  const mockResult = mockCommandResults ? findMockResult(command, mockCommandResults) : null;
  if (mockResult) {
    const delayMs = Number(mockResult.delayMs ?? 0);
    return new Promise((resolve, reject) => {
      let timeoutHandle: NodeJS.Timeout | null = null;
      const cleanup = (): void => {
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
          timeoutHandle = null;
        }
        abortSignal?.removeEventListener('abort', abort);
      };
      const abort = (): void => {
        cleanup();
        reject(getAbortError(abortSignal));
      };
      const complete = (): void => {
        cleanup();
        resolve({
          exitCode: Number(mockResult.exitCode ?? 1),
          output: `${String(mockResult.stdout || '')}${String(mockResult.stderr || '')}`.trim(),
        });
      };
      if (abortSignal?.aborted) {
        abort();
        return;
      }
      abortSignal?.addEventListener('abort', abort, { once: true });
      if (Number.isFinite(delayMs) && delayMs > 0) {
        timeoutHandle = setTimeout(complete, delayMs);
      } else {
        complete();
      }
    });
  }

  return spawnPowerShellAsync(command, { cwd: repoRoot }).then((result) => ({
    exitCode: result.exitCode,
    output: result.output,
  }));
}

export function normalizeToolTypeFromCommand(command: string): string {
  const trimmed = String(command || '').trim();
  if (!trimmed) {
    return 'unknown';
  }
  const match = /^"([^"]+)"|^'([^']+)'|^([^\s]+)/u.exec(trimmed);
  const firstToken = (match?.[1] || match?.[2] || match?.[3] || '').trim();
  if (!firstToken) {
    return 'unknown';
  }
  const normalized = firstToken.replace(/^[\\/]+/u, '').replace(/[\\/]+$/u, '');
  const parts = normalized.split(/[\\/]/u).filter(Boolean);
  const family = (parts[parts.length - 1] || normalized || 'unknown').trim().toLowerCase();
  return family || 'unknown';
}
