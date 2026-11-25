import { setTimeout as delay } from 'node:timers/promises';

import { getAbortError } from '../../lib/abort.ts';
import { copyText } from '../../lib/bounded-output.ts';
import type { CapturedCommand } from '../../lib/captured-command.ts';
import { keepOutput } from '../../output-digest/kept-output.ts';
import { reportedOutput, startAgentCommand } from './agent-command.ts';

const JOBS_PER_RUN = 2;
const JOBS_PER_SERVER = 4;
/** Finished jobs whose results a run can still ask for. */
const RESULTS_KEPT = 8;
/** Characters of a job's output kept once it ends; the digest reads all of it first. */
const RESULT_MAX_CHARS = 200_000;
const DIGEST_MAX_CHARS = 20_000;
const LIVE_TAIL_CHARS = 8_000;
const LISTED_COMMAND_CHARS = 120;

function formatSeconds(milliseconds: number): string {
  return `${Math.round(milliseconds / 1000)} s`;
}

/** Running jobs across every run of the server. */
export class BackgroundJobSlots {
  private used = 0;

  get inUse(): number {
    return this.used;
  }

  tryTake(): boolean {
    if (this.used >= JOBS_PER_SERVER) return false;
    this.used += 1;
    return true;
  }

  release(): void {
    if (this.used === 0) throw new Error('A background job slot was released twice.');
    this.used -= 1;
  }
}

type JobOutcome = { label: string; exitCode: number; elapsedMs: number; output: string; digest: string | null };

type JobState = {
  readonly id: string;
  readonly command: string;
  readonly startedAtMs: number;
  readonly changedPaths: Set<string>;
  stopRequested: boolean;
  /** Null once the job has ended, so its output window is free to collect. */
  running: CapturedCommand | null;
  outcome: JobOutcome | null;
};

/** `ended` settles when the job has ended and its slot is back. */
type Job = JobState & { readonly ended: Promise<void> };

export type JobReply = { ok: true; exitCode: number; output: string; digest: string | null } | { ok: false; reason: string };

export type StartJobInput = { command: string; cwd: string; timeoutMs: number; env: Record<string, string> };

/** Every background job of one run. Nothing it starts outlives `dispose`. */
export class BackgroundJobs {
  private readonly slots: BackgroundJobSlots;
  private readonly jobs = new Map<string, Job>();
  private nextId = 1;
  private disposal: Promise<void> | null = null;

  constructor(slots: BackgroundJobSlots) {
    this.slots = slots;
  }

  start(input: StartJobInput): JobReply {
    if (this.disposal) return { ok: false, reason: 'the run is ending; no background job can start' };
    const running = this.running();
    if (running.length >= JOBS_PER_RUN) {
      return { ok: false, reason: `this run already has ${JOBS_PER_RUN} background jobs running (${running.map((job) => job.id).join(', ')}); wait for or stop one first` };
    }
    if (!this.slots.tryTake()) {
      return { ok: false, reason: `all ${JOBS_PER_SERVER} background jobs of this server are in use; run the command in the foreground or try later` };
    }
    let command: CapturedCommand;
    try {
      command = startAgentCommand(input.command, { cwd: input.cwd, timeoutMs: input.timeoutMs, env: input.env });
    } catch (error) {
      this.slots.release();
      throw error;
    }
    const state: JobState = {
      id: `j${this.nextId}`, command: input.command, startedAtMs: Date.now(), changedPaths: new Set(),
      stopRequested: false, running: command, outcome: null,
    };
    this.nextId += 1;
    const job: Job = Object.assign(state, { ended: this.settle(state, command) });
    this.jobs.set(job.id, job);
    return { ok: true, exitCode: 0, digest: null,
      output: `Started background job ${job.id} (limit ${formatSeconds(input.timeoutMs)}). Use job with action wait, output or stop; it is killed when this run ends.` };
  }

  private async settle(job: JobState, command: CapturedCommand): Promise<void> {
    let outcome: JobOutcome;
    try {
      const result = await command.result;
      const label = result.timedOut ? 'timed out' : job.stopRequested ? 'stopped' : `exited ${result.exitCode}`;
      const kept = keepOutput(reportedOutput(result), { tailChars: RESULT_MAX_CHARS, digestChars: DIGEST_MAX_CHARS });
      outcome = {
        label, exitCode: result.exitCode, elapsedMs: Date.now() - job.startedAtMs, ...kept,
      };
    } catch (error) {
      outcome = { label: 'failed', exitCode: 1, elapsedMs: Date.now() - job.startedAtMs, digest: null,
        output: error instanceof Error ? error.message : String(error) };
    } finally {
      this.slots.release();
      job.running = null;
    }
    job.outcome = outcome;
    this.forgetOldResults();
  }

  private forgetOldResults(): void {
    const finished = [...this.jobs.values()].filter((job) => job.outcome !== null);
    for (const job of finished.slice(0, Math.max(0, finished.length - RESULTS_KEPT))) this.jobs.delete(job.id);
  }

  running(): { id: string; command: string; elapsedMs: number }[] {
    return [...this.jobs.values()].filter((job) => job.running !== null)
      .map((job) => ({ id: job.id, command: job.command, elapsedMs: Date.now() - job.startedAtMs }));
  }

  /** Records a file this run wrote while jobs were running, so their results can say so. */
  noteChangedPath(path: string): void {
    for (const job of this.jobs.values()) if (job.running !== null) job.changedPaths.add(path);
  }

  async wait(jobId: string, waitMs: number, abortSignal: AbortSignal | undefined): Promise<JobReply> {
    const job = this.jobs.get(jobId);
    if (job === undefined) return this.unknown(jobId);
    if (job.outcome === null) await this.waitForEnd(job, waitMs, abortSignal);
    return this.report(job);
  }

  private async waitForEnd(job: Job, waitMs: number, abortSignal: AbortSignal | undefined): Promise<void> {
    const timer = new AbortController();
    const signal = abortSignal === undefined ? timer.signal : AbortSignal.any([timer.signal, abortSignal]);
    try {
      await Promise.race([job.ended, delay(waitMs, undefined, { signal })]);
    } catch (error) {
      if (abortSignal?.aborted) throw getAbortError(abortSignal);
      throw error;
    } finally {
      timer.abort();
    }
  }

  output(jobId: string): JobReply {
    const job = this.jobs.get(jobId);
    return job === undefined ? this.unknown(jobId) : this.report(job);
  }

  async stop(jobId: string): Promise<JobReply> {
    const job = this.jobs.get(jobId);
    if (job === undefined) return this.unknown(jobId);
    this.kill(job);
    await job.ended;
    return this.report(job);
  }

  private kill(job: Job): void {
    if (job.running === null) return;
    job.stopRequested = true;
    job.running.terminate();
  }

  list(): JobReply {
    return { ok: true, exitCode: 0, digest: null, output: this.describe() ?? 'This run has no background jobs.' };
  }

  /** One line per kept job; null when there are none. */
  describe(): string | null {
    if (this.jobs.size === 0) return null;
    return ['Background jobs of this run:', ...[...this.jobs.values()].map((job) => `- ${job.id} ${this.status(job)}: ${this.shortCommand(job)}`)].join('\n');
  }

  /** Kills every running job and names them; null when none was running. */
  async stopAll(): Promise<string | null> {
    const stopped = [...this.jobs.values()].filter((job) => job.running !== null);
    for (const job of stopped) this.kill(job);
    await Promise.all(stopped.map((job) => job.ended));
    return stopped.length === 0 ? null
      : `Background jobs killed because the run ended: ${stopped.map((job) => `${job.id} (${this.shortCommand(job)})`).join('; ')}`;
  }

  /** Ends every job and refuses new ones; safe to call again, and safe to call while a wait is pending. */
  dispose(): Promise<void> {
    this.disposal ??= this.stopAll().then(() => { this.jobs.clear(); });
    return this.disposal;
  }

  private unknown(jobId: string): JobReply {
    const known = [...this.jobs.keys()].join(', ') || 'none';
    return { ok: false, reason: `no background job "${jobId}"; known jobs: ${known}. Only the last ${RESULTS_KEPT} finished results are kept.` };
  }

  private shortCommand(job: Job): string {
    return job.command.length <= LISTED_COMMAND_CHARS ? job.command : `${job.command.slice(0, LISTED_COMMAND_CHARS)}…`;
  }

  private status(job: Job): string {
    return job.outcome === null ? `running for ${formatSeconds(Date.now() - job.startedAtMs)}`
      : `${job.outcome.label} after ${formatSeconds(job.outcome.elapsedMs)}`;
  }

  /** The status line comes last: a long result keeps its tail. */
  private report(job: Job): JobReply {
    const { outcome } = job;
    const body = outcome === null ? copyText((job.running?.outputSoFar() ?? '').slice(-LIVE_TAIL_CHARS)) : outcome.output;
    const changed = job.changedPaths.size === 0 ? [] : [`Files this run wrote while it ran: ${[...job.changedPaths].join(', ')}`];
    return {
      ok: true, exitCode: outcome?.exitCode ?? 0, digest: outcome?.digest ?? null,
      output: [body.trim() || '(no output yet)', ...changed, `[job ${job.id} ${this.status(job)}]`].join('\n'),
    };
  }
}
