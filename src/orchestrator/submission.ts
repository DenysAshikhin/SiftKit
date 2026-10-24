import {
  ORCHESTRATOR_MAX_RESUBMITS,
  orchestratorCheckFailure,
  type OrchestratorCheckResult,
  type OrchestratorHandoffReport,
  type OrchestratorSubmissionOutcome,
  type OrchestratorTask,
} from '@siftkit/contracts';

import type { SubmissionGate, SubmissionVerdict } from '../repo-search/engine/submission-gate.ts';
import { HANDOFF_REPORT_MAX_CHARS, parseHandoffReport, renderReportInstruction, type HandoffKind } from './handoff.ts';
import type { WorkspaceChanges } from './workspace.ts';

/** Unusable reports a child may send back, per problem, before its attempt ends without a new one. */
const MAX_UNUSABLE_REPORTS = { length: 2, shape: 2 } as const;
/** How much of each failing check's output the child reads back. */
const CHECK_OUTPUT_TAIL_CHARS = 4_000;

/** What the run does for a submission: its checks under the run's approval policy, and the changes charged to the child. */
export interface SubmissionHost {
  runTaskChecks(task: OrchestratorTask): Promise<OrchestratorCheckResult[]>;
  measureChanges(task: OrchestratorTask): Promise<WorkspaceChanges>;
}

/** The last judged submission: what the attempt result records. */
export type SubmissionRecord = {
  report: OrchestratorHandoffReport | null;
  outcome: Exclude<OrchestratorSubmissionOutcome, 'not_submitted'>;
  submissions: number;
  checks: OrchestratorCheckResult[];
  changes: WorkspaceChanges;
  findings: string[];
};

/**
 * One child's finish gate. Code runs the task's checks on every finish; a failing check goes back to the same
 * child until its resubmits run out, and an unusable report is sent back apart from it.
 */
export class WorkerSubmission implements SubmissionGate {
  private submissions = 0;
  private readonly unusable = { length: 0, shape: 0 };
  private last: SubmissionRecord | null = null;
  private readonly host: SubmissionHost;
  private readonly task: OrchestratorTask;
  private readonly kind: HandoffKind;
  private readonly repoRoot: string;

  constructor(host: SubmissionHost, input: { task: OrchestratorTask; kind: HandoffKind; repoRoot: string }) {
    this.host = host;
    this.task = input.task;
    this.kind = input.kind;
    this.repoRoot = input.repoRoot;
  }

  /** The judged submission the child ended on; null when it never finished. */
  record(): SubmissionRecord | null {
    return this.last;
  }

  async review(answer: string): Promise<SubmissionVerdict> {
    // Once its length retries are spent, a well-shaped report is judged at any length rather than discarded.
    const enforceLength = this.unusable.length < MAX_UNUSABLE_REPORTS.length;
    const parsed = parseHandoffReport(answer, this.kind, this.repoRoot, enforceLength);
    if (!parsed.ok) {
      this.unusable[parsed.reason] += 1;
      if (this.unusable[parsed.reason] > MAX_UNUSABLE_REPORTS[parsed.reason]) {
        this.last = await this.endWithoutUsableReport(parsed.problem);
        return { kind: 'accept', output: answer };
      }
      return { kind: 'reject', message: parsed.reason === 'length'
        ? parsed.problem
        : [`Your report could not be used: ${parsed.problem}`, renderReportInstruction(this.kind)].join('\n') };
    }
    this.submissions += 1;
    const checks = await this.host.runTaskChecks(this.task);
    const changes = await this.host.measureChanges(this.task);
    const findings = checks.flatMap((check) => orchestratorCheckFailure(check) ?? []);
    const outcome = findings.length > 0 ? 'checks_failed' : 'passed';
    const overrun = answer.length - HANDOFF_REPORT_MAX_CHARS;
    const notes = overrun > 0 ? [`The report ran ${overrun} characters over the ${HANDOFF_REPORT_MAX_CHARS} limit after its length retries.`] : [];
    this.last = { report: parsed.report, outcome, submissions: this.submissions, checks, changes, findings: [...findings, ...notes] };
    if (outcome !== 'checks_failed' || this.submissions > ORCHESTRATOR_MAX_RESUBMITS) return { kind: 'accept', output: answer };
    return { kind: 'reject', message: [
      `Your submission ${this.submissions} of ${ORCHESTRATOR_MAX_RESUBMITS + 1} failed its checks:`,
      ...findings.map((finding) => `- ${finding}`),
      ...checks.filter((check) => orchestratorCheckFailure(check) !== null)
        .map((check) => `Output of ${orchestratorCheckFailure(check) ?? ''}\n${check.output.slice(-CHECK_OUTPUT_TAIL_CHARS)}`),
      'Fix the problems, then finish again with an updated report.',
    ].join('\n') };
  }

  /** Keeps the last judged submission when there is one, re-measured, so its report and checks still reach the orchestrator. */
  private async endWithoutUsableReport(problem: string): Promise<SubmissionRecord> {
    const changes = await this.host.measureChanges(this.task);
    const unusable = `Later reports were unusable: ${problem}`;
    if (this.last === null) {
      return { report: null, outcome: 'report_invalid', submissions: 0, checks: [], changes,
        findings: [`No usable report: ${problem}`] };
    }
    const edited = changes.digest === this.last.changes.digest ? []
      : ['The workspace changed after its checks ran; they do not cover the current files.'];
    return { ...this.last, changes, findings: [...this.last.findings, ...edited, unusable] };
  }
}
