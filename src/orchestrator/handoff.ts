import {
  OrchestratorHandoffReportSchema,
  orchestratorCheckFailure,
  type OrchestratorAttemptResult,
  type OrchestratorCheckResult,
  type OrchestratorCommandCheck,
  type OrchestratorHandoffReport,
} from '@siftkit/contracts';

import { toError } from '../lib/errors.ts';
import { JsonObjectSchema } from '../lib/json-types.ts';
import { ModelJson } from '../lib/model-json.ts';
import { cutDigest } from '../output-digest/digest.ts';
import type { DiffstatEntry } from './workspace.ts';

/** A report this long would crowd the orchestrator's context; about 2.2k tokens. */
export const HANDOFF_REPORT_MAX_CHARS = 9_000;
/** How much of a failing check's output the orchestrator reads beside a report. */
const CHECK_OUTPUT_CHARS = 1_500;
/** How much of a final answer stands in for a report the child never made usable. */
const FINAL_ANSWER_TAIL_CHARS = 2_000;

/** A length overrun and a malformed report are separate problems with separate budgets. */
export type ParsedHandoff = { ok: true; report: OrchestratorHandoffReport } | { ok: false; reason: 'length' | 'shape'; problem: string };

const REPORT_TEMPLATE = JSON.stringify({
  status: 'completed | incomplete',
  deviations: [{ what: 'a step skipped or done differently, a file changed beyond the expected ones, or work left undone', why: 'the reason' }],
});

/** The closing lines of a child's assignment and of every rejected shape: the limits, then the template itself. */
export function renderReportInstruction(): string {
  return [`Finish with only this JSON report, no prose, under ${HANDOFF_REPORT_MAX_CHARS} characters:`, REPORT_TEMPLATE].join('\n');
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

/** The child's final answer as its report: within size, the report's shape, and an incomplete status explained. */
export function parseHandoffReport(answer: string, enforceLength: boolean): ParsedHandoff {
  if (enforceLength && answer.length > HANDOFF_REPORT_MAX_CHARS) return { ok: false, reason: 'length', problem: describeOverrun(answer) };
  let report: OrchestratorHandoffReport;
  try {
    report = ModelJson.parseObject(answer, OrchestratorHandoffReportSchema, 'handoff report');
  } catch (error) {
    return { ok: false, reason: 'shape', problem: toError(error).message };
  }
  return report.status === 'incomplete' && report.deviations.length === 0
    ? { ok: false, reason: 'shape', problem: 'An incomplete report names what was left undone in deviations.' }
    : { ok: true, report };
}

/** One settled attempt as the orchestrator reads it: the child's status and deviations, the measured diffstat, the gate's last checks. */
export function renderAttemptForParent(result: OrchestratorAttemptResult, diffstat: readonly DiffstatEntry[]): string {
  const checkFailures = new Set(result.checks.map((check) => orchestratorCheckFailure(check)));
  const findings = result.findings.filter((finding) => !checkFailures.has(finding));
  const commandChecks = result.checks.filter(isCommandCheck);
  return [
    `## ${result.taskId} (${result.purpose} attempt ${result.attempt}): ${result.outcome}, worker ${result.workerStatus}, `
      + `${result.submissions} submission(s)`,
    ...(result.report === null
      ? [`No usable report. End of the final answer:\n${result.workerOutput.slice(-FINAL_ANSWER_TAIL_CHARS)}`]
      : renderReport(result.report)),
    renderChanges(diffstat),
    ...(findings.length > 0 ? [`Host findings:\n${findings.map((finding) => `- ${finding}`).join('\n')}`] : []),
    ...(commandChecks.length > 0 ? [`Checks (the gate's last run):\n${commandChecks.map(renderCheck).join('\n')}`] : []),
  ].join('\n');
}

function list(title: string, entries: readonly string[]): string[] {
  return entries.length === 0 ? [] : [`${title}:\n${entries.map((entry) => `- ${entry}`).join('\n')}`];
}

function renderReport(report: OrchestratorHandoffReport): string[] {
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
    + renderCheckOutput(check, CHECK_OUTPUT_CHARS);
}

/** A check's output for a model within `maxChars`: its digest in at most half, then the output's tail. */
export function renderCheckOutput(result: OrchestratorCheckResult, maxChars: number): string {
  if (result.digest === null) return result.output.slice(-maxChars);
  const digest = cutDigest(result.digest, maxChars / 2);
  return `${digest}\n${result.output.slice(Math.max(0, result.output.length - (maxChars - digest.length - 1)))}`;
}
