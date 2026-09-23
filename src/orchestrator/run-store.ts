import { randomUUID } from 'node:crypto';

import {
  ORCHESTRATOR_MAX_ATTEMPTS,
  ORCHESTRATOR_TERMINAL_PHASES,
  OrchestratorAttemptResultSchema,
  OrchestratorAttemptSchema,
  OrchestratorEventSchema,
  OrchestratorRunStateSchema,
  OrchestratorStartRequestSchema,
  isOrchestratorTerminalPhase,
  type OrchestratorAttempt,
  type OrchestratorAttemptResult,
  type OrchestratorChildPurpose,
  type OrchestratorChildWork,
  type OrchestratorEvent,
  type OrchestratorPlan,
  type OrchestratorRunState,
  type OrchestratorStartRequest,
  type OrchestratorTaskState,
} from '@siftkit/contracts';

import { digestStableJson } from '../lib/json-digest.js';
import { parseJsonValueText } from '../lib/json.js';
import { canonicalRepositoryKey } from '../lib/repository-key.js';
import { z } from '../lib/zod.js';
import type { RuntimeDatabase } from '../state/database-handle.js';

/** The parent state as stored; attempts live in their own keyed table. */
const StoredRunStateSchema = OrchestratorRunStateSchema.omit({ attempts: true });
type StoredRunState = z.infer<typeof StoredRunStateSchema>;

const RunRowSchema = z.object({ run_id: z.string(), request_digest: z.string(), state_json: z.string() });
const AttemptRowsSchema = z.array(z.object({ attempt_json: z.string() }));
const EventRowsSchema = z.array(z.object({ event_json: z.string() }));
const MaxSequenceRowSchema = z.object({ sequence: z.number().int().nullable() });
const RunIdRowsSchema = z.array(z.object({ run_id: z.string() }));
const TERMINAL_PHASES_SQL = ORCHESTRATOR_TERMINAL_PHASES.map((phase) => `'${phase}'`).join(', ');

/** Fields a transition may change; identity, plan, and attempts change only through their methods. */
export type OrchestratorRunChanges = Partial<Pick<OrchestratorRunState, 'phase' | 'tasks' | 'approval' | 'failure' | 'phaseRunIds'>>;

/** What an event says beyond the committed phase; the store stamps run, sequence, and time. */
export type OrchestratorEventInput = {
  message: string;
  taskId?: string;
  purpose?: OrchestratorChildPurpose;
  attempt?: number;
  childRunId?: string;
};

/**
 * Durable orchestrator parents. Every mutation checks the caller's revision, bumps it, and appends
 * its event in one transaction, so a reconnect or duplicate caller can never reserve work twice.
 */
export class OrchestratorRunStore {
  constructor(private readonly database: RuntimeDatabase) {}

  create(input: OrchestratorStartRequest): OrchestratorRunState {
    const request = OrchestratorStartRequestSchema.parse(input);
    const digest = digestStableJson(request);
    return this.database.transaction(() => {
      const existing = this.database.prepare('SELECT run_id, request_digest, state_json FROM orchestrator_runs WHERE submission_id = ?')
        .get(request.submissionId);
      if (existing) {
        const row = RunRowSchema.parse(existing);
        if (row.request_digest !== digest) {
          throw new Error(`Submission ${request.submissionId} was already used for a different orchestrator request.`);
        }
        return this.read(row.run_id);
      }
      const now = new Date().toISOString();
      const state: StoredRunState = StoredRunStateSchema.parse({
        runId: randomUUID(), request, revision: 0, phase: 'preparing_plan', planPath: null, planHash: null, plan: null,
        tasks: [], phaseRunIds: [], approval: null, failure: null, createdAtUtc: now, updatedAtUtc: now,
      });
      this.database.prepare(`
        INSERT INTO orchestrator_runs (run_id, submission_id, request_digest, revision, phase, state_json, created_at_utc, updated_at_utc, repo_key)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(state.runId, request.submissionId, digest, state.revision, state.phase, JSON.stringify(state), now, now,
        canonicalRepositoryKey(request.repoRoot));
      this.appendEvent(state, { message: 'Orchestrator run created.' });
      return this.read(state.runId);
    })();
  }

  read(runId: string): OrchestratorRunState {
    const row = this.database.prepare('SELECT run_id, request_digest, state_json FROM orchestrator_runs WHERE run_id = ?').get(runId);
    if (!row) throw new Error(`Unknown orchestrator run ${runId}.`);
    const stored = StoredRunStateSchema.parse(parseJsonValueText(RunRowSchema.parse(row).state_json));
    return OrchestratorRunStateSchema.parse({ ...stored, attempts: this.readAttempts(runId) });
  }

  /** Nonterminal parents, for startup reconciliation. */
  listActive(): OrchestratorRunState[] {
    return RunIdRowsSchema.parse(this.database.prepare(
      `SELECT run_id FROM orchestrator_runs WHERE phase NOT IN (${TERMINAL_PHASES_SQL}) ORDER BY created_at_utc, rowid`,
    ).all()).map((row) => this.read(row.run_id));
  }

  /** The most recent parents of one repository (by identity, not path spelling), newest first. */
  listRecent(repoRoot: string, limit: number): OrchestratorRunState[] {
    return RunIdRowsSchema.parse(this.database.prepare(
      'SELECT run_id FROM orchestrator_runs WHERE repo_key = ? ORDER BY created_at_utc DESC, rowid DESC LIMIT ?',
    ).all(canonicalRepositoryKey(repoRoot), limit)).map((row) => this.read(row.run_id));
  }

  /** Saves a (re)validated plan; a task that already has attempts can never be dropped or renamed. */
  savePlan(runId: string, revision: number, plan: OrchestratorPlan, planPath: string, contentHash: string): OrchestratorRunState {
    return this.mutate(runId, revision, (state) => {
      const planned = new Set(plan.tasks.map((task) => task.id));
      for (const attempt of state.attempts) {
        if (!planned.has(attempt.taskId)) {
          throw new Error(`Plan changed: task '${attempt.taskId}' already has attempts; start a new run for the changed plan.`);
        }
      }
      const previous = new Map(state.tasks.map((task) => [task.taskId, task]));
      const tasks: OrchestratorTaskState[] = plan.tasks.map((task) => previous.get(task.id)
        ?? { taskId: task.id, status: 'pending', driftReview: null, reviewedDigests: [] });
      return { stored: { ...state, plan, planPath, planHash: contentHash, tasks }, event: { message: `Plan saved: ${planPath}.` } };
    });
  }

  update(runId: string, revision: number, changes: OrchestratorRunChanges, event: OrchestratorEventInput): OrchestratorRunState {
    return this.mutate(runId, revision, (state) => ({ stored: { ...state, ...changes }, event }));
  }

  /** Reserves the next attempt of the work's purpose and its child ID before anything starts. */
  reserveAttempt(runId: string, revision: number, taskId: string, work: OrchestratorChildWork): OrchestratorAttempt {
    const purpose: OrchestratorChildPurpose = work.kind;
    const childRunId = randomUUID();
    const state = this.mutate(runId, revision, (current) => {
      if (!current.tasks.some((task) => task.taskId === taskId)) throw new Error(`Task '${taskId}' is not in the saved plan.`);
      const used = current.attempts.filter((attempt) => attempt.taskId === taskId && attempt.purpose === purpose).length;
      if (used >= ORCHESTRATOR_MAX_ATTEMPTS) throw new Error(`Task '${taskId}' reached the ${purpose} attempt limit.`);
      const attempt = OrchestratorAttemptSchema.parse({
        taskId, purpose, attempt: used + 1, childRunId, work, status: 'reserved', result: null,
        reservedAtUtc: new Date().toISOString(),
      });
      this.database.prepare(`
        INSERT INTO orchestrator_attempts (run_id, task_id, purpose, attempt, child_run_id, attempt_json) VALUES (?, ?, ?, ?, ?, ?)
      `).run(runId, taskId, purpose, attempt.attempt, childRunId, JSON.stringify(attempt));
      return { stored: current, event: { message: `Reserved ${purpose} attempt ${attempt.attempt}.`, taskId, purpose,
        attempt: attempt.attempt, childRunId } };
    });
    return this.requireAttempt(state, childRunId);
  }

  markAttemptRunning(runId: string, revision: number, childRunId: string): OrchestratorRunState {
    return this.mutate(runId, revision, (state) => {
      const attempt = this.requireAttempt(state, childRunId);
      if (attempt.status !== 'reserved') throw new Error(`Orchestrator child ${childRunId} was already started.`);
      this.writeAttempt(runId, { ...attempt, status: 'running' });
      return { stored: state, event: { message: `Started ${attempt.purpose} attempt ${attempt.attempt}.`,
        taskId: attempt.taskId, purpose: attempt.purpose, attempt: attempt.attempt, childRunId } };
    });
  }

  recordAttemptResult(runId: string, revision: number, input: OrchestratorAttemptResult): OrchestratorRunState {
    const result = OrchestratorAttemptResultSchema.parse(input);
    return this.mutate(runId, revision, (state) => {
      const attempt = this.requireAttempt(state, result.childRunId);
      if (attempt.status === 'settled') throw new Error(`Orchestrator child ${result.childRunId} is already settled.`);
      if (attempt.taskId !== result.taskId || attempt.purpose !== result.purpose || attempt.attempt !== result.attempt) {
        throw new Error(`Result for child ${result.childRunId} does not match its reserved attempt.`);
      }
      this.writeAttempt(runId, { ...attempt, status: 'settled', result });
      return { stored: state, event: { message: `Settled ${attempt.purpose} attempt ${attempt.attempt}: ${result.passed ? 'passed' : 'failed'}.`,
        taskId: attempt.taskId, purpose: attempt.purpose, attempt: attempt.attempt, childRunId: attempt.childRunId } };
    });
  }

  markInterrupted(runId: string, revision: number, reason: string): OrchestratorRunState {
    return this.update(runId, revision, {
      phase: 'interrupted', approval: null,
      failure: { code: 'interrupted', message: reason, taskId: null, purpose: null, findingIds: [] },
    }, { message: reason });
  }

  readEvents(runId: string, afterSequence: number): OrchestratorEvent[] {
    const rows = EventRowsSchema.parse(this.database.prepare(
      'SELECT event_json FROM orchestrator_events WHERE run_id = ? AND sequence > ? ORDER BY sequence',
    ).all(runId, afterSequence));
    return rows.map((row) => OrchestratorEventSchema.parse(parseJsonValueText(row.event_json)));
  }

  private mutate(
    runId: string,
    revision: number,
    change: (state: OrchestratorRunState) => { stored: OrchestratorRunState; event: OrchestratorEventInput },
  ): OrchestratorRunState {
    return this.database.transaction(() => {
      const current = this.read(runId);
      if (current.revision !== revision) {
        throw new Error(`Orchestrator run ${runId} stale revision ${revision}; current revision is ${current.revision}.`);
      }
      if (isOrchestratorTerminalPhase(current.phase)) throw new Error(`Orchestrator run ${runId} is ${current.phase}.`);
      const { stored, event } = change(current);
      const { attempts: _attempts, ...fields } = stored;
      const next = StoredRunStateSchema.parse({ ...fields, revision: revision + 1, updatedAtUtc: new Date().toISOString() });
      this.database.prepare('UPDATE orchestrator_runs SET revision = ?, phase = ?, state_json = ?, updated_at_utc = ? WHERE run_id = ?')
        .run(next.revision, next.phase, JSON.stringify(next), next.updatedAtUtc, runId);
      this.appendEvent(next, event);
      return this.read(runId);
    })();
  }

  private appendEvent(state: StoredRunState, input: OrchestratorEventInput): void {
    const last = MaxSequenceRowSchema.parse(this.database.prepare(
      'SELECT MAX(sequence) AS sequence FROM orchestrator_events WHERE run_id = ?',
    ).get(state.runId)).sequence ?? 0;
    const event = OrchestratorEventSchema.parse({
      runId: state.runId, sequence: last + 1, atUtc: new Date().toISOString(), phase: state.phase, message: input.message,
      taskId: input.taskId ?? null, purpose: input.purpose ?? null, attempt: input.attempt ?? null, childRunId: input.childRunId ?? null,
    });
    this.database.prepare('INSERT INTO orchestrator_events (run_id, sequence, event_json) VALUES (?, ?, ?)')
      .run(state.runId, event.sequence, JSON.stringify(event));
  }

  private readAttempts(runId: string): OrchestratorAttempt[] {
    const rows = AttemptRowsSchema.parse(this.database.prepare(
      'SELECT attempt_json FROM orchestrator_attempts WHERE run_id = ? ORDER BY rowid',
    ).all(runId));
    return rows.map((row) => OrchestratorAttemptSchema.parse(parseJsonValueText(row.attempt_json)));
  }

  private requireAttempt(state: OrchestratorRunState, childRunId: string): OrchestratorAttempt {
    const attempt = state.attempts.find((entry) => entry.childRunId === childRunId);
    if (!attempt) throw new Error(`Unknown orchestrator child ${childRunId} for run ${state.runId}.`);
    return attempt;
  }

  private writeAttempt(runId: string, attempt: OrchestratorAttempt): void {
    this.database.prepare('UPDATE orchestrator_attempts SET attempt_json = ? WHERE run_id = ? AND child_run_id = ?')
      .run(JSON.stringify(OrchestratorAttemptSchema.parse(attempt)), runId, attempt.childRunId);
  }
}
