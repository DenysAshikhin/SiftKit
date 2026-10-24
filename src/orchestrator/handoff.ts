import { existsSync, readFileSync, statSync } from 'node:fs';

import {
  OrchestratorAgentReportSchema,
  OrchestratorSearchReportSchema,
  orchestratorCheckFailure,
  type OrchestratorAttemptResult,
  type OrchestratorCheckResult,
  type OrchestratorCitation,
  type OrchestratorCommandCheck,
  type OrchestratorHandoffReport,
} from '@siftkit/contracts';

import { toError } from '../lib/errors.ts';
import { JsonObjectSchema } from '../lib/json-types.ts';
import { ModelJson } from '../lib/model-json.ts';
import { resolveRepoScopedPath } from '../repo-search/engine/repo-paths.ts';
import type { DiffstatEntry } from './workspace.ts';

/** A report this long would crowd the orchestrator's context; about 2.2k tokens. */
export const HANDOFF_REPORT_MAX_CHARS = 9_000;
/** How much of a failing check's output the orchestrator reads beside a report. */
const CHECK_OUTPUT_TAIL_CHARS = 1_500;
/** How much of a final answer stands in for a report the child never made usable. */
const FINAL_ANSWER_TAIL_CHARS = 2_000;

export type HandoffKind = OrchestratorHandoffReport['kind'];
/** A length overrun and a malformed report are separate problems with separate budgets. */
export type ParsedHandoff = { ok: true; report: OrchestratorHandoffReport } | { ok: false; reason: 'length' | 'shape'; problem: string };

const REPORT_TEMPLATES: Record<HandoffKind, string> = {
  agent: JSON.stringify({
    kind: 'agent', status: 'completed | incomplete',
    deviations: [{ what: 'a step skipped or done differently, a file changed beyond the expected ones, or work left undone', why: 'the reason' }],
  }),
  search: JSON.stringify({
    kind: 'search',
    findings: [{ claim: 'where something is and what it does: one path:line per function or symbol; no field lists, no code',
      evidence: [{ path: 'src/file.ts', line: 1 }] }],
    unknowns: ['what you could not determine'],
  }),
};

/** The closing lines of a child's assignment and of every rejected shape: the limits, then the template itself. */
export function renderReportInstruction(kind: HandoffKind): string {
  return [
    `Finish with only this JSON report, no prose, under ${HANDOFF_REPORT_MAX_CHARS} characters:`,
    REPORT_TEMPLATES[kind],
  ].join('\n');
}

/** Why a cited location does not exist: a missing file or a line past its end. */
export function findCitationProblem(repoRoot: string, citation: OrchestratorCitation): string | null {
  const resolved = resolveRepoScopedPath(repoRoot, citation.path);
  if (resolved === null || !existsSync(resolved.absolutePath) || !statSync(resolved.absolutePath).isFile()) {
    return `${citation.path} is not a file in the repository`;
  }
  const lineCount = readFileSync(resolved.absolutePath, 'utf8').split(/\r?\n/u).length;
  return citation.line > lineCount ? `${citation.path}:${citation.line} is past the end of the file` : null;
}

/** Why a well-shaped report still cannot be used: an unexplained incomplete status, or citations that do not resolve. */
function findReportProblem(report: OrchestratorHandoffReport, repoRoot: string): string | null {
  if (report.kind === 'agent') {
    return report.status === 'incomplete' && report.deviations.length === 0
      ? 'An incomplete report names what was left undone in deviations.' : null;
  }
  const problems = report.findings.flatMap((finding) => finding.evidence).flatMap((citation) => {
    const problem = findCitationProblem(repoRoot, citation);
    return problem === null ? [] : [problem];
  });
  return problems.length === 0 ? null : `Citations do not resolve: ${problems.join('; ')}.`;
}

/** How far over the limit a report is, and which of its top-level fields to shorten. */
function describeOverrun(answer: string): string {
  let fields = '';
  try {
    const value = ModelJson.parseObject(answer, JsonObjectSchema, 'handoff report');
    fields = Object.entries(value).map(([key, field]): [string, number] => [key, JSON.stringify(field).length])
      .sort((left, right) => right[1] - left[1]).slice(0, 3).map(([key, length]) => `${key} (${length})`).join(', ');
  } catch {
    fields = '';
  }
  return `The report is ${answer.length} characters, ${answer.length - HANDOFF_REPORT_MAX_CHARS} over the ${HANDOFF_REPORT_MAX_CHARS} limit`
    + `${fields === '' ? '' : `; longest fields: ${fields}`}. Shorten it and keep the same shape.`;
}

/** The child's final answer as its report: within size, the expected kind's shape, nothing unexplained or unresolved. */
export function parseHandoffReport(answer: string, kind: HandoffKind, repoRoot: string, enforceLength: boolean): ParsedHandoff {
  if (enforceLength && answer.length > HANDOFF_REPORT_MAX_CHARS) return { ok: false, reason: 'length', problem: describeOverrun(answer) };
  let report: OrchestratorHandoffReport;
  try {
    report = kind === 'agent'
      ? ModelJson.parseObject(answer, OrchestratorAgentReportSchema, 'agent report')
      : ModelJson.parseObject(answer, OrchestratorSearchReportSchema, 'search report');
  } catch (error) {
    return { ok: false, reason: 'shape', problem: toError(error).message };
  }
  const problem = findReportProblem(report, repoRoot);
  return problem === null ? { ok: true, report } : { ok: false, reason: 'shape', problem };
}

/** One settled attempt as the orchestrator reads it: the child's status and deviations, the measured diffstat, the gate's last checks. */
export function renderAttemptForParent(result: OrchestratorAttemptResult, diffstat: readonly DiffstatEntry[]): string {
  const checkFailures = new Set(result.checks.map((check) => orchestratorCheckFailure(check)));
  const findings = result.findings.filter((finding) => !checkFailures.has(finding));
  const commandChecks = result.checks.filter(isCommandCheck);
  // A search changes nothing, so only a writer's empty diffstat is news.
  const showChanges = diffstat.length > 0 || result.report?.kind !== 'search';
  return [
    `## ${result.taskId} (${result.purpose} attempt ${result.attempt}): ${result.outcome}, worker ${result.workerStatus}, `
      + `${result.submissions} submission(s)`,
    ...(result.report === null
      ? [`No usable report. End of the final answer:\n${result.workerOutput.slice(-FINAL_ANSWER_TAIL_CHARS)}`]
      : renderReport(result.report)),
    ...(showChanges ? [renderChanges(diffstat)] : []),
    ...(findings.length > 0 ? [`Host findings:\n${findings.map((finding) => `- ${finding}`).join('\n')}`] : []),
    ...(commandChecks.length > 0 ? [`Checks (the gate's last run):\n${commandChecks.map(renderCheck).join('\n')}`] : []),
  ].join('\n');
}

function list(title: string, entries: readonly string[]): string[] {
  return entries.length === 0 ? [] : [`${title}:\n${entries.map((entry) => `- ${entry}`).join('\n')}`];
}

function renderReport(report: OrchestratorHandoffReport): string[] {
  if (report.kind === 'search') {
    // Claims name their own anchors; the evidence list only lets the host verify them.
    return [...list('Findings', report.findings.map((finding) => finding.claim)), ...list('Unknowns', report.unknowns)];
  }
  return [`Status: ${report.status}`, ...(report.deviations.length === 0 ? ['Deviations: none.']
    : list('Deviations', report.deviations.map((deviation) => `${deviation.what} Why: ${deviation.why}`)))];
}

/** Measured line counts per path; the code itself stays in the workspace for the orchestrator to read. */
function renderChanges(diffstat: readonly DiffstatEntry[]): string {
  if (diffstat.length === 0) return 'Changes: none.';
  return `Changes (measured since the attempt began):\n${diffstat.map((entry) => {
    const counts = entry.added === null || entry.removed === null ? 'binary' : `+${entry.added} -${entry.removed}`;
    return `- ${entry.path} ${counts}${entry.change === 'modified' ? '' : ` (${entry.change === 'added' ? 'new' : 'deleted'})`}`;
  }).join('\n')}`;
}

type CommandCheckResult = OrchestratorCheckResult & { check: OrchestratorCommandCheck };

function isCommandCheck(check: OrchestratorCheckResult): check is CommandCheckResult {
  return check.check.kind === 'command';
}

function renderCheck(check: CommandCheckResult): string {
  const failure = orchestratorCheckFailure(check);
  if (failure === null) return `- pass \`${check.check.command}\``;
  return `- FAIL \`${check.check.command}\` ${!check.executed ? 'never ran' : check.timedOut ? 'timed out' : `exited ${check.exitCode ?? 'unknown'}`}\n`
    + check.output.slice(-CHECK_OUTPUT_TAIL_CHARS);
}
