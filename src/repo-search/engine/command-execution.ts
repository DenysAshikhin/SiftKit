import { spawnPowerShellAsync } from '../../lib/powershell.js';
import type { RepoSearchMockCommandResult } from '../types.js';
import { getAbortError, throwIfAborted } from '../../lib/abort.js';
import { AGENT_RUN_ID_ENV } from '../../lib/agent-run-marker.js';
import { spawnDirectCommand } from '../../lib/command-spawn.js';
import { toStringRecord } from '../../lib/captured-command.js';

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

/** Command families safe to spawn without a shell. */
const DIRECT_SPAWN_EXECUTABLES = new Set(['git']);

/**
 * Anything that needs shell interpretation (pipes, chaining, redirects,
 * expansion) stays on the PowerShell path. Checked on the raw string, so a
 * quoted metacharacter also bails — conservative and correct either way.
 */
const SHELL_METACHARACTERS = /[|&;<>$`()\r\n]/u;

function tokenizeCommand(text: string): string[] | null {
  const tokens: string[] = [];
  let current = '';
  let inToken = false;
  let quote: '"' | "'" | null = null;
  for (const char of text) {
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      inToken = true;
      continue;
    }
    if (char === ' ' || char === '\t') {
      if (inToken) {
        tokens.push(current);
        current = '';
        inToken = false;
      }
      continue;
    }
    current += char;
    inToken = true;
  }
  if (quote) {
    return null;
  }
  if (inToken) {
    tokens.push(current);
  }
  return tokens;
}

export function parseDirectSpawnCommand(command: string): { executable: string; args: string[] } | null {
  const trimmed = String(command || '').trim();
  if (!trimmed || SHELL_METACHARACTERS.test(trimmed)) {
    return null;
  }
  const tokens = tokenizeCommand(trimmed);
  const firstToken = tokens?.[0];
  if (!tokens || !firstToken) {
    return null;
  }
  const executable = firstToken.toLowerCase();
  if (!DIRECT_SPAWN_EXECUTABLES.has(executable)) {
    return null;
  }
  return { executable, args: tokens.slice(1) };
}

export function executeRepoCommand(
  command: string,
  repoRoot: string,
  mockCommandResults: Record<string, RepoSearchMockCommandResult> | null,
  agentRunId: string,
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

  const direct = parseDirectSpawnCommand(command);
  if (direct) {
    return spawnDirectCommand(direct.executable, direct.args, {
      cwd: repoRoot,
      abortSignal,
      env: { ...toStringRecord(process.env), [AGENT_RUN_ID_ENV]: agentRunId },
    }).then((result) => ({
      exitCode: result.exitCode,
      output: result.output,
    }));
  }

  return spawnPowerShellAsync(command, {
    cwd: repoRoot,
    env: { [AGENT_RUN_ID_ENV]: agentRunId },
  }).then((result) => ({
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
