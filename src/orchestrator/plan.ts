import { posix } from 'node:path';

import type { OrchestratorPlan, OrchestratorTask, OrchestratorVerificationCheck, SiftPreset } from '@siftkit/contracts';

import type { SiftConfig } from '../config/types.ts';
import { PresetCatalog } from '../preset-catalog.ts';
import { resolveRepoScopedPath } from '../repo-search/engine/repo-paths.ts';

const MUTATING_TOOLS = ['write', 'edit', 'run'] as const;

/** Workers are repo-agent presets that can change files; orchestrators never delegate to orchestrators. */
export function isOrchestratorWorker(preset: SiftPreset): boolean {
  return preset.presetKind === 'repo-agent' && MUTATING_TOOLS.some((tool) => preset.allowedTools.includes(tool));
}

export function requireOrchestratorWorkerPreset(config: SiftConfig, task: Pick<OrchestratorTask, 'id' | 'workerPresetId'>): SiftPreset {
  const preset = PresetCatalog.fromPresets(config.Presets).requireById(task.workerPresetId);
  if (!isOrchestratorWorker(preset)) {
    throw new Error(`Task '${task.id}' selects preset '${preset.id}' (${preset.presetKind}); workers must be repo-agent presets that can change files.`);
  }
  return preset;
}

const TEST_PATH = /(^|\/)(tests?|__tests__)\/|\.(test|spec)\.[cm]?[jt]sx?$/u;

/** Changed test files the task never named in writePaths; a review must judge each one. */
export function findTestPathsOutsideScope(task: Pick<OrchestratorTask, 'writePaths'>, changedPaths: readonly string[]): string[] {
  const inScope = (path: string): boolean => task.writePaths.some((entry) => entry === '.' || path === entry || path.startsWith(`${entry}/`));
  return changedPaths.filter((path) => TEST_PATH.test(path) && !inScope(path));
}

/** The most files one task may expect to change; larger tasks compacted mid-task or stalled in run e85529c8. */
export const ORCHESTRATOR_MAX_WRITE_PATHS = 8;

/**
 * Problems with the write paths a save_plan or update_tasks call adds or changes: too many for one worker, or a new
 * test file whose name already exists elsewhere. Tasks whose writePaths the call leaves alone are not judged again.
 */
export function findPlanPathProblems(previous: OrchestratorPlan | null, next: OrchestratorPlan, repositoryFiles: readonly string[]): string[] {
  const before = new Map((previous?.tasks ?? []).map((task) => [task.id, task.writePaths.join('\n')]));
  const existing = new Set(repositoryFiles);
  const byName = new Map<string, string[]>();
  for (const file of repositoryFiles) byName.set(posix.basename(file), [...(byName.get(posix.basename(file)) ?? []), file]);
  const problems: string[] = [];
  for (const task of next.tasks) {
    if (before.get(task.id) === task.writePaths.join('\n')) continue;
    if (task.writePaths.length > ORCHESTRATOR_MAX_WRITE_PATHS) {
      problems.push(`Task '${task.id}' lists ${task.writePaths.length} writePaths; a task may change at most ${ORCHESTRATOR_MAX_WRITE_PATHS} paths.`
        + ' Split it into tasks that each finish within one worker context.');
    }
    for (const writePath of task.writePaths) {
      if (existing.has(writePath) || !TEST_PATH.test(writePath)) continue;
      const twins = byName.get(posix.basename(writePath)) ?? [];
      if (twins.length === 0) continue;
      problems.push(`Task '${task.id}' creates '${writePath}', but ${twins.map((twin) => `'${twin}'`).join(', ')} already exists:`
        + ' name the existing test file, or give a new file a name that says how it differs.');
    }
  }
  return problems;
}

function scopePath(repoRoot: string, owner: string, rawPath: string): string {
  const resolved = resolveRepoScopedPath(repoRoot, rawPath);
  if (resolved === null) throw new Error(`${owner} path '${rawPath.replace(/\\/gu, '/')}' escapes the repository.`);
  return resolved.relativePath || '.';
}

/** Temporary paths are removed from the run scratch at completion, so the run must be able to delete them. */
function scopeTemporaryPath(owner: string, repoRoot: string, scratchDir: string, rawPath: string): string {
  const scoped = scopePath(repoRoot, owner, rawPath);
  if (!scoped.startsWith(`${scratchDir}/`)) {
    throw new Error(`${owner} temporary path '${rawPath.replace(/\\/gu, '/')}' must live in the run scratch '${scratchDir}', which the run deletes at completion.`);
  }
  return scoped;
}

function scopeChecks(repoRoot: string, owner: string, checks: OrchestratorVerificationCheck[]): OrchestratorVerificationCheck[] {
  return checks.map((check) => (check.kind === 'command'
    ? { ...check, cwd: scopePath(repoRoot, owner, check.cwd) }
    : { ...check, paths: check.paths.map((entry) => scopePath(repoRoot, owner, entry)) }));
}

function assertDependencies(tasks: OrchestratorTask[]): void {
  const byId = new Map<string, OrchestratorTask>();
  for (const task of tasks) {
    if (byId.has(task.id)) throw new Error(`Duplicate task id '${task.id}'.`);
    byId.set(task.id, task);
  }
  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (dependency === task.id) throw new Error(`Task '${task.id}' depends on itself.`);
      if (!byId.has(dependency)) throw new Error(`Task '${task.id}' depends on missing task '${dependency}': add '${dependency}' in this same call, or remove it from dependsOn.`);
    }
  }
  const finished = new Set<string>();
  const visit = (task: OrchestratorTask, trail: string[]): void => {
    if (finished.has(task.id)) return;
    const cycleStart = trail.indexOf(task.id);
    if (cycleStart >= 0) throw new Error(`Plan tasks form a dependency cycle: ${[...trail.slice(cycleStart), task.id].join(' -> ')}.`);
    for (const dependency of task.dependsOn) {
      const next = byId.get(dependency);
      if (next) visit(next, [...trail, task.id]);
    }
    finished.add(task.id);
  };
  for (const task of tasks) visit(task, []);
}

/**
 * Structural and capability validation: dependency graph, worker kinds and tools, repository
 * containment of every path, and temporary paths inside the run scratch. Returns the plan with
 * repository-relative POSIX path keys.
 */
export function validateOrchestratorPlan(plan: OrchestratorPlan, config: SiftConfig, repoRoot: string, scratchDir: string): OrchestratorPlan {
  assertDependencies(plan.tasks);
  const tasks = plan.tasks.map((task) => {
    requireOrchestratorWorkerPreset(config, task);
    if (task.writePaths.length === 0) throw new Error(`Task '${task.id}' lists no writePaths; name the files it is expected to change.`);
    const owner = `Task '${task.id}'`;
    return {
      ...task,
      readPaths: task.readPaths.map((entry) => scopePath(repoRoot, owner, entry)),
      writePaths: task.writePaths.map((entry) => scopePath(repoRoot, owner, entry)),
      temporaryPaths: task.temporaryPaths.map((entry) => scopeTemporaryPath(owner, repoRoot, scratchDir, entry)),
      verification: scopeChecks(repoRoot, owner, task.verification),
    };
  });
  return { ...plan, tasks, finalVerification: scopeChecks(repoRoot, 'Final verification', plan.finalVerification) };
}

function renderCheck(check: OrchestratorVerificationCheck): string {
  return check.kind === 'command'
    ? `- Run \`${check.command}\` in \`${check.cwd}\`; expected exit ${check.expectedExitCode}.`
    : `- ${check.instruction} (evidence: ${check.paths.map((entry) => `\`${entry}\``).join(', ')})`;
}

function renderList(values: readonly string[], empty: string): string[] {
  return values.length === 0 ? [`- ${empty}`] : values.map((value) => `- ${value}`);
}

/** The complete Markdown form of a generated or rewritten plan; the stored manifest is its source. */
export function renderOrchestratorPlan(plan: OrchestratorPlan): string {
  return [
    `# ${plan.goal}`, '',
    '## Constraints', ...renderList(plan.constraints, 'None.'), '',
    ...plan.tasks.flatMap((task) => [
      `## Task ${task.id}: ${task.title}`, '',
      ...(task.why === null ? [] : [task.why, '']),
      `- Worker: \`${task.workerPresetId}\``,
      `- Depends on: ${task.dependsOn.length === 0 ? 'none' : task.dependsOn.map((id) => `\`${id}\``).join(', ')}`,
      `- Reads: ${task.readPaths.length === 0 ? 'none' : task.readPaths.map((entry) => `\`${entry}\``).join(', ')}`,
      `- Writes: ${task.writePaths.map((entry) => `\`${entry}\``).join(', ')}`,
      `- Temporary: ${task.temporaryPaths.length === 0 ? 'none' : task.temporaryPaths.map((entry) => `\`${entry}\``).join(', ')}`, '',
      '### Steps', '',
      ...task.steps.flatMap((step, index) => [`${index + 1}. ${step.instruction}`, `   Expected: ${step.expectedResult}`]), '',
      '### Verification', '', ...task.verification.map(renderCheck), '',
      '### Acceptance', '', ...renderList(task.acceptance, 'None.'), '',
    ]),
    '## Final verification', '', ...plan.finalVerification.map(renderCheck), '',
  ].join('\n');
}
