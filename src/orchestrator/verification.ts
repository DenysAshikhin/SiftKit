import { existsSync, readFileSync } from 'node:fs';

import type {
  OrchestratorCheckResult,
  OrchestratorCodeEvidence,
  OrchestratorCommandCheck,
  OrchestratorVerificationCheck,
} from '@siftkit/contracts';

import { TIMEOUT_EXIT_CODE } from '../lib/captured-command.ts';
import { DEFAULT_RUN_TIMEOUT_MS, spawnPowerShellAsync } from '../lib/powershell.ts';
import { resolveRepoScopedPath } from '../repo-search/engine/repo-paths.ts';

const CHECK_OUTPUT_MAX_CHARS = 20_000;
const SNIPPET_LINE_TOLERANCE = 2;

/** A check recorded without running: an evidence check awaiting review, or a denied command. */
export function unexecutedCheck(check: OrchestratorVerificationCheck, output: string): OrchestratorCheckResult {
  return { check, executed: false, exitCode: null, timedOut: false, output };
}

/**
 * Runs one declared command check for real inside the repository. No model lease is held while it runs, so it
 * carries no nested-run marker: a check that calls this server waits its turn instead of being refused.
 */
export async function runVerificationCheck(input: {
  repoRoot: string;
  check: OrchestratorCommandCheck;
  abortSignal: AbortSignal;
  timeoutMs?: number;
}): Promise<OrchestratorCheckResult> {
  const { check } = input;
  const cwd = resolveRepoScopedPath(input.repoRoot, check.cwd);
  if (cwd === null) throw new Error(`Verification cwd '${check.cwd}' escapes the repository.`);
  const result = await spawnPowerShellAsync(check.command, {
    cwd: cwd.absolutePath, abortSignal: input.abortSignal, timeoutMs: input.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS,
  });
  input.abortSignal.throwIfAborted();
  return { check, executed: true, exitCode: result.exitCode, timedOut: result.exitCode === TIMEOUT_EXIT_CODE,
    output: result.output.slice(-CHECK_OUTPUT_MAX_CHARS) };
}

function normalizeCode(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

/** Why cited code evidence does not hold: a missing file, a line past the end, or a snippet not at that line. */
export function findEvidenceProblem(repoRoot: string, evidence: OrchestratorCodeEvidence): string | null {
  const resolved = resolveRepoScopedPath(repoRoot, evidence.path);
  if (resolved === null || !existsSync(resolved.absolutePath)) return `${evidence.path} does not exist in the repository`;
  const lines = readFileSync(resolved.absolutePath, 'utf8').split(/\r?\n/u);
  if (evidence.line > lines.length) return `${evidence.path}:${evidence.line} is past the end of the file`;
  const window = lines.slice(Math.max(0, evidence.line - 1 - SNIPPET_LINE_TOLERANCE), evidence.line + SNIPPET_LINE_TOLERANCE).join('\n');
  return normalizeCode(window).includes(normalizeCode(evidence.snippet))
    ? null : `${evidence.path}:${evidence.line} does not contain the cited snippet`;
}
