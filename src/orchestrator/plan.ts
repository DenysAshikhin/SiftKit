import type { OrchestratorPlan, OrchestratorTask, OrchestratorVerificationCheck, SiftPreset } from '@siftkit/contracts';

import type { SiftConfig } from '../config/types.js';
import { PresetCatalog } from '../preset-catalog.js';
import { resolveRepoScopedPath } from '../repo-search/engine/repo-paths.js';

const MUTATING_TOOLS = ['write', 'edit', 'run'] as const;

/** A worker that can change the checkout needs exclusive repository ownership. */
export function workerCanMutate(preset: SiftPreset): boolean {
  return MUTATING_TOOLS.some((tool) => preset.allowedTools.includes(tool));
}

/** Workers the orchestrator may start; orchestrators never delegate to orchestrators. */
export function requireOrchestratorWorkerPreset(config: SiftConfig, task: Pick<OrchestratorTask, 'id' | 'workerPresetId'>): SiftPreset {
  const preset = PresetCatalog.fromPresets(config.Presets).requireById(task.workerPresetId);
  if (preset.presetKind !== 'repo-agent' && preset.presetKind !== 'repo-search') {
    throw new Error(`Task '${task.id}' selects preset '${preset.id}' of kind '${preset.presetKind}'; workers must be repo-agent or repo-search presets.`);
  }
  if (preset.presetKind === 'repo-search') {
    const granted = MUTATING_TOOLS.filter((tool) => preset.allowedTools.includes(tool));
    if (granted.length > 0) throw new Error(`Read-only worker preset '${preset.id}' grants mutating tools: ${granted.join(', ')}.`);
  }
  return preset;
}

function scopePath(repoRoot: string, owner: string, rawPath: string): string {
  const resolved = resolveRepoScopedPath(repoRoot, rawPath);
  if (resolved === null) throw new Error(`${owner} path '${rawPath.replace(/\\/gu, '/')}' escapes the repository.`);
  return resolved.relativePath || '.';
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
      if (!byId.has(dependency)) throw new Error(`Task '${task.id}' depends on missing task '${dependency}'.`);
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
 * Structural and capability validation: dependency graph, worker kinds and tools, and repository
 * containment of every path. Returns the plan with repository-relative POSIX path keys.
 */
export function validateOrchestratorPlan(plan: OrchestratorPlan, config: SiftConfig, repoRoot: string): OrchestratorPlan {
  assertDependencies(plan.tasks);
  const tasks = plan.tasks.map((task) => {
    const worker = requireOrchestratorWorkerPreset(config, task);
    if (worker.presetKind === 'repo-search' && task.writePaths.length > 0) {
      throw new Error(`Task '${task.id}' uses read-only worker '${worker.id}' but declares write paths.`);
    }
    const owner = `Task '${task.id}'`;
    return {
      ...task,
      readPaths: task.readPaths.map((entry) => scopePath(repoRoot, owner, entry)),
      writePaths: task.writePaths.map((entry) => scopePath(repoRoot, owner, entry)),
      temporaryPaths: task.temporaryPaths.map((entry) => scopePath(repoRoot, owner, entry)),
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
      `- Worker: \`${task.workerPresetId}\``,
      `- Depends on: ${task.dependsOn.length === 0 ? 'none' : task.dependsOn.map((id) => `\`${id}\``).join(', ')}`,
      `- Reads: ${task.readPaths.length === 0 ? 'none' : task.readPaths.map((entry) => `\`${entry}\``).join(', ')}`,
      `- Writes: ${task.writePaths.length === 0 ? 'none (read-only)' : task.writePaths.map((entry) => `\`${entry}\``).join(', ')}`,
      `- Temporary: ${task.temporaryPaths.length === 0 ? 'none' : task.temporaryPaths.map((entry) => `\`${entry}\``).join(', ')}`, '',
      '### Steps', '',
      ...task.steps.flatMap((step, index) => [`${index + 1}. ${step.instruction}`, `   Expected: ${step.expectedResult}`]), '',
      '### Verification', '', ...task.verification.map(renderCheck), '',
      '### Acceptance', '', ...renderList(task.acceptance, 'None.'), '',
    ]),
    '## Final verification', '', ...plan.finalVerification.map(renderCheck), '',
  ].join('\n');
}
