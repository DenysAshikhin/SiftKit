import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { spawnDirectCommand, type DirectCommandResult } from '../lib/command-spawn.js';
import { SAFE_GIT_BASE_ARGS, scrubGitEnvironment } from '../repo-search/engine/read-only-git-tool.js';

/** Repository-relative POSIX directory holding one run's plan, scratch, and evidence. */
export function orchestratorArtifactDir(runId: string): string {
  return `.siftkit/orchestrator/${runId}`;
}

export function orchestratorScratchDir(runId: string): string {
  return `${orchestratorArtifactDir(runId)}/scratch`;
}

const ORCHESTRATOR_ARTIFACT_ROOT = '.siftkit/orchestrator/';
const PROSE_EXTENSIONS = ['.md', '.mdx', '.txt', '.rst', '.log'];

/** Dirty files at one moment: path -> content (null for a deleted file). */
export type WorkspaceSnapshot = ReadonlyMap<string, Buffer | null>;

export type WorkspaceChanges = {
  /** Paths whose content differs from the baseline, sorted. */
  paths: string[];
  /** Digest of exactly these paths and contents; null when nothing changed. */
  digest: string | null;
};

/** Git with fsmonitor, external diff, and inherited GIT_* variables disabled. */
function runGit(repoRoot: string, args: string[]): Promise<DirectCommandResult> {
  return spawnDirectCommand('git', [...SAFE_GIT_BASE_ARGS, ...args], { cwd: repoRoot, env: scrubGitEnvironment() });
}

async function git(repoRoot: string, args: string[]): Promise<string> {
  const result = await runGit(repoRoot, args);
  if (result.exitCode !== 0) throw new Error(`git ${args[0] ?? ''} failed (${result.exitCode}): ${result.stderr.trim()}`);
  return result.stdout;
}

function readContent(repoRoot: string, path: string): Buffer | null {
  const absolute = join(repoRoot, path);
  return existsSync(absolute) && lstatSync(absolute).isFile() ? readFileSync(absolute) : null;
}

function contentHash(content: Buffer | null): string {
  return content === null ? 'deleted' : createHash('sha256').update(content).digest('hex');
}

/** Every dirty path outside run artifacts, from `git status -z` (a rename contributes both sides). */
async function listDirtyPaths(repoRoot: string): Promise<string[]> {
  const fields = (await git(repoRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])).split('\0');
  const paths: string[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index] ?? '';
    if (field.length < 4) continue;
    paths.push(field.slice(3));
    if (field[0] === 'R' || field[0] === 'C') {
      const source = fields[index + 1];
      if (source) paths.push(source);
      index += 1;
    }
  }
  return [...new Set(paths)].filter((path) => !path.startsWith(ORCHESTRATOR_ARTIFACT_ROOT)).sort();
}

export async function captureWorkspace(repoRoot: string): Promise<WorkspaceSnapshot> {
  const snapshot = new Map<string, Buffer | null>();
  for (const path of await listDirtyPaths(repoRoot)) snapshot.set(path, readContent(repoRoot, path));
  return snapshot;
}

/** Content changed since `baseline`; a pre-existing edit left untouched is not a change. */
export async function diffWorkspace(repoRoot: string, baseline: WorkspaceSnapshot): Promise<WorkspaceChanges> {
  const candidates = new Set([...baseline.keys(), ...await listDirtyPaths(repoRoot)]);
  const changed: string[] = [];
  const digest = createHash('sha256');
  for (const path of [...candidates].sort()) {
    const current = readContent(repoRoot, path);
    const before = baseline.has(path) ? baseline.get(path) ?? null : await headContent(repoRoot, path);
    if (contentHash(before) === contentHash(current)) continue;
    changed.push(path);
    digest.update(`${path}\0${contentHash(current)}\n`);
  }
  return { paths: changed, digest: changed.length === 0 ? null : digest.digest('hex') };
}

async function headContent(repoRoot: string, path: string): Promise<Buffer | null> {
  const result = await runGit(repoRoot, ['cat-file', '-p', `HEAD:${path}`]);
  return result.exitCode === 0 ? Buffer.from(result.stdout) : null;
}

/** Unified diff of `paths` from their baseline content to now, staged through the run's scratch. */
export async function renderWorkspaceDiff(input: {
  repoRoot: string;
  baseline: WorkspaceSnapshot;
  paths: readonly string[];
  scratchDir: string;
}): Promise<string> {
  const stagingRoot = join(input.repoRoot, input.scratchDir, '.diff-staging');
  const stage = (name: string, content: Buffer | null): string => {
    const staged = join(stagingRoot, name);
    mkdirSync(dirname(staged), { recursive: true });
    writeFileSync(staged, content ?? '');
    return staged;
  };
  const sections: string[] = [];
  try {
    for (const path of input.paths) {
      const tracked = await headContent(input.repoRoot, path) !== null;
      // A path clean at the baseline diffs against HEAD, which git normalizes for line endings.
      const args = !input.baseline.has(path) && tracked
        ? ['diff', '--no-color', '--no-ext-diff', '--no-textconv', 'HEAD', '--', path]
        : ['diff', '--no-index', '--no-color', '--no-ext-diff', '--no-textconv', '--ignore-cr-at-eol', '--', stage(`before/${path}`, input.baseline.get(path) ?? null),
          existsSync(join(input.repoRoot, path)) ? path : stage(`deleted/${path}`, null)];
      const result = await runGit(input.repoRoot, args);
      sections.push(`### ${path}\n${result.stdout.trim() || '(binary or line-ending-only change)'}`);
    }
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true });
  }
  return sections.join('\n');
}

function isWithin(root: string, candidate: string): boolean {
  const offset = relative(root, candidate);
  return offset !== '' && !offset.startsWith('..') && !isAbsolute(offset);
}

/** Changed paths the task may not touch; run artifacts are always allowed. */
export function findScopeViolations(changedPaths: readonly string[], writePaths: readonly string[]): string[] {
  return changedPaths.filter((path) => !path.startsWith(ORCHESTRATOR_ARTIFACT_ROOT)
    && !writePaths.some((allowed) => allowed === '.' || path === allowed || path.startsWith(`${allowed.replace(/\/$/u, '')}/`)));
}

/** Source, tests, scripts, and config changes need a drift review; prose and logs do not. */
export function changesNeedDriftReview(changedPaths: readonly string[]): boolean {
  return changedPaths.some((path) => !path.startsWith(ORCHESTRATOR_ARTIFACT_ROOT)
    && !PROSE_EXTENSIONS.some((extension) => path.toLowerCase().endsWith(extension)));
}

/**
 * Deletes one run-owned temporary path. The candidate must resolve, through real paths, strictly
 * inside the scratch root; the root itself, traversal, sibling prefixes, and links out are rejected.
 */
export function removeOwnedTemporaryPath(repoRoot: string, scratchDir: string, candidate: string): void {
  const scratchRoot = resolve(repoRoot, scratchDir);
  mkdirSync(scratchRoot, { recursive: true });
  const realScratch = realpathSync.native(scratchRoot);
  const target = resolve(repoRoot, candidate);
  if (!isWithin(scratchRoot, target)) throw new Error(`Refusing to delete '${candidate}': it is not inside the run scratch directory.`);
  if (!existsSync(target) && !isSymbolicLink(target)) return;
  const realParent = realpathSync.native(dirname(target));
  if (realParent !== realScratch && !isWithin(realScratch, realParent)) {
    throw new Error(`Refusing to delete '${candidate}': its real location is outside the run scratch directory.`);
  }
  // A link inside scratch is removed as the link itself; its outside target is never followed.
  rmSync(target, { recursive: !isSymbolicLink(target), force: true });
}

function isSymbolicLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Empties the run scratch directory entry by entry through the containment check. */
export function cleanupScratch(repoRoot: string, scratchDir: string): void {
  const scratchRoot = resolve(repoRoot, scratchDir);
  if (!existsSync(scratchRoot)) return;
  const failures: string[] = [];
  for (const entry of readdirSync(scratchRoot)) {
    try {
      removeOwnedTemporaryPath(repoRoot, scratchDir, `${scratchDir}${sep}${entry}`);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
    if (existsSync(join(scratchRoot, entry)) || isSymbolicLink(join(scratchRoot, entry))) {
      failures.push(`Temporary path '${scratchDir}/${entry}' could not be deleted.`);
    }
  }
  if (failures.length > 0) throw new Error(`Scratch cleanup failed: ${[...new Set(failures)].join(' ')}`);
}
