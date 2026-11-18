import { existsSync, statSync } from 'node:fs';

import type {
  OrchestratorCheckResult,
  OrchestratorCodeEvidence,
  OrchestratorCommandCheck,
  OrchestratorReviewFinding,
  OrchestratorVerificationCheck,
} from '@siftkit/contracts';

import { TIMEOUT_EXIT_CODE } from '../lib/captured-command.ts';
import { describeFileLines } from '../lib/source-lines.ts';
import { DEFAULT_RUN_TIMEOUT_MS, spawnPowerShellAsync } from '../lib/powershell.ts';
import { resolveRepoScopedPath } from '../repo-search/engine/repo-paths.ts';
import { cutDigest, digestOutput } from '../output-digest/digest.ts';

const CHECK_OUTPUT_MAX_CHARS = 20_000;
const SNIPPET_LINE_TOLERANCE = 2;

/** A check recorded without running: an evidence check awaiting review, or a denied command. */
export function unexecutedCheck(check: OrchestratorVerificationCheck, output: string): OrchestratorCheckResult {
  return { check, executed: false, exitCode: null, timedOut: false, output, digest: null };
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
  // The digest reads the whole output; the stored output keeps its tail and the stored digest its head.
  const digest = digestOutput(result.output);
  return { check, executed: true, exitCode: result.exitCode, timedOut: result.exitCode === TIMEOUT_EXIT_CODE,
    output: result.output.slice(-CHECK_OUTPUT_MAX_CHARS), digest: digest === null ? null : cutDigest(digest.text, CHECK_OUTPUT_MAX_CHARS) };
}

function normalizeCode(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

/** Why cited code evidence does not hold: a missing file, a line past the end, or a snippet not at that line. */
export function findEvidenceProblem(repoRoot: string, evidence: OrchestratorCodeEvidence): string | null {
  const cited = readCitedLines(repoRoot, evidence.path, `${evidence.path} does not exist in the repository`);
  if ('problem' in cited) return cited.problem;
  if (evidence.line > cited.lines.length) return `${evidence.path}:${evidence.line} is past the end of the file`;
  const window = cited.lines.slice(Math.max(0, evidence.line - 1 - SNIPPET_LINE_TOLERANCE), evidence.line + SNIPPET_LINE_TOLERANCE).join('\n');
  if (normalizeCode(window).includes(normalizeCode(evidence.snippet))) return null;
  // Showing the line lets the reviewer correct the citation in one retry instead of rereading the file.
  return `${evidence.path}:${evidence.line} does not contain the cited snippet; line ${evidence.line} is `
    + `\`${(cited.lines[evidence.line - 1] ?? '').trim()}\`. Cite one line exactly as read shows it`;
}

/** Why a cited location does not exist: a missing file or a line past its end. */
export function findCitationProblem(repoRoot: string, citation: Pick<OrchestratorReviewFinding, 'path' | 'line'>): string | null {
  const cited = readCitedLines(repoRoot, citation.path, `${citation.path} is not a file in the repository`);
  if ('problem' in cited) return cited.problem;
  return citation.line > cited.lines.length ? `${citation.path}:${citation.line} is past the end of the file` : null;
}

/** A cited path's lines as read counts them, or why the checks cannot read it; `missing` words an absent path. */
function readCitedLines(repoRoot: string, path: string, missing: string): { lines: string[] } | { problem: string } {
  const resolved = resolveRepoScopedPath(repoRoot, path);
  if (resolved === null || !existsSync(resolved.absolutePath)) return { problem: missing };
  if (!statSync(resolved.absolutePath).isFile()) return { problem: `${path} is not a file in the repository` };
  const fileLines = describeFileLines(resolved.absolutePath);
  return fileLines.kind === 'text' ? { lines: fileLines.lines } : { problem: `${path} is not a text file the checks can read` };
}
