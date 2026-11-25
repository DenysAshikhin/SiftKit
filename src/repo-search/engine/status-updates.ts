import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import type { ToolActivityKind } from '@siftkit/contracts';
import { BACKGROUND_JOB_TOOL_NAME } from '../../planner-protocol/repo-search.ts';

import { toError } from '../../lib/errors.ts';
import type { PlannerActionResponse } from '../planner-protocol.ts';
import { findStatusTextProblem } from '../status-text.ts';
import type { JsonLogger } from '../types.ts';
import type { ProgressReporter } from './progress-reporter.ts';

const CALLS_PER_UPDATE = 10;
/** How long a command must have run before an update is written, so quick commands cost nothing. */
const WINDOW_MS = 3_000;
const SPACING_MS = 60_000;
/** How long the next planner request may wait for a cancelled update to let go of the engine. */
const SETTLE_MS = 1_000;
const RECENT_ACTIVITIES = 5;
const ACTIVITY_MAX_CHARS = 200;
const MAX_WORDS = 45;
/** Asked for; a reply up to MAX_WORDS is still shown, because models overrun a little. */
export const STATUS_UPDATE_ASKED_WORDS = 30;
/** The tools whose execution leaves the engine idle. */
const WINDOW_TOOLS = new Set(['run', BACKGROUND_JOB_TOOL_NAME]);

export interface StatusUpdateRequester {
  requestStatusUpdate(instruction: string, abortSignal: AbortSignal): Promise<PlannerActionResponse>;
}

type RunningCommand = { turn: number; command: string };

/** The reply as it may be shown, or why it may not. */
export function parseStatusUpdate(reply: string): { ok: true; text: string } | { ok: false; problem: string } {
  const trimmed = reply.trim();
  if (trimmed === '') return { ok: false, problem: 'it was empty' };
  if (/\n\s*\n/u.test(trimmed)) return { ok: false, problem: 'it must be one paragraph' };
  const text = trimmed.replace(/\s*\n\s*/gu, ' ');
  if (text.split(/\s+/u).length > MAX_WORDS) return { ok: false, problem: `it was over ${MAX_WORDS} words` };
  const problem = findStatusTextProblem(text);
  return problem === null ? { ok: true, text } : { ok: false, problem };
}

export function buildStatusUpdateInstruction(input: { command: string; recent: readonly string[]; previous: string | null }): string {
  return [
    `This command is running now: ${input.command}`,
    ...(input.recent.length === 0 ? [] : ['Your latest steps, oldest first:', ...input.recent.map((activity) => `- ${activity}`)]),
    ...(input.previous === null ? [] : [`Your last update was: "${input.previous}" Do not repeat it.`]),
    `While it runs, tell the person watching what you are doing. Reply with only one or two short plain sentences, at most ${STATUS_UPDATE_ASKED_WORDS} words:`,
    'the goal, why it matters now, and progress if it is clear. Do not name files, paths, commands, tools, code or tests. Say nothing',
    'you have not confirmed: "checking a suspected problem", not "found a bug". Do not call a tool. Your work continues afterwards.',
  ].join('\n');
}

/** Decides when a run writes an update, writes it while a command runs, and keeps it out of the run itself. */
export class StatusUpdates {
  private readonly requester: StatusUpdateRequester;
  private readonly progress: ProgressReporter;
  private readonly logger: JsonLogger | null;
  private due = false;
  private callsSinceUpdate = 0;
  private lastStartedAtMs: number | null = null;
  private previous: string | null = null;
  private readonly recent: string[] = [];
  private timer: NodeJS.Timeout | null = null;
  private request: { abort: AbortController; settled: Promise<void> } | null = null;

  constructor(options: { requester: StatusUpdateRequester; progress: ProgressReporter; logger: JsonLogger | null }) {
    this.requester = options.requester;
    this.progress = options.progress;
    this.logger = options.logger;
  }

  toolStarted(tool: RunningCommand & { toolName: string; activityKind: ToolActivityKind }): void {
    this.recent.push(`${tool.activityKind}: ${tool.command}`.slice(0, ACTIVITY_MAX_CHARS));
    if (this.recent.length > RECENT_ACTIVITIES + 1) this.recent.shift();
    if (tool.activityKind === 'validate') this.due = true;
    if (!this.due || !WINDOW_TOOLS.has(tool.toolName)) return;
    const spacingMs = this.lastStartedAtMs === null ? 0 : this.lastStartedAtMs + SPACING_MS - Date.now();
    this.timer = setTimeout(() => this.write(tool), Math.max(WINDOW_MS, spacingMs));
  }

  /** The command ended: an update not written by now would delay the run, so it is dropped. */
  toolFinished(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.request?.abort.abort(new Error('The command ended before its status update.'));
    this.callsSinceUpdate += 1;
    if (this.callsSinceUpdate >= CALLS_PER_UPDATE) this.due = true;
  }

  /** Waits for a cancelled update to let go of the engine, but never long. */
  async settle(): Promise<void> {
    if (this.request === null) return;
    const bound = new AbortController();
    await Promise.race([this.request.settled, delay(SETTLE_MS, undefined, { signal: bound.signal }).catch(() => undefined)]);
    bound.abort();
  }

  private write(command: RunningCommand): void {
    this.timer = null;
    if (this.request !== null) return;
    const abort = new AbortController();
    const instruction = buildStatusUpdateInstruction({ command: command.command, recent: this.recent.slice(0, -1), previous: this.previous });
    this.due = false;
    this.callsSinceUpdate = 0;
    this.lastStartedAtMs = Date.now();
    const settled = this.ask(command, instruction, abort.signal).finally(() => { this.request = null; });
    this.request = { abort, settled };
  }

  /** Never throws: an update that cannot be written shows nothing and changes nothing. */
  private async ask(command: RunningCommand, instruction: string, abortSignal: AbortSignal): Promise<void> {
    const startedAtMs = Date.now();
    let outcome = 'shown';
    let usage: Pick<PlannerActionResponse, 'promptCacheTokens' | 'promptEvalTokens'> = {};
    try {
      const response = await this.requester.requestStatusUpdate(instruction, abortSignal);
      usage = { promptCacheTokens: response.promptCacheTokens, promptEvalTokens: response.promptEvalTokens };
      const parsed = response.toolCalls.length > 0 ? { ok: false as const, problem: 'it called a tool' } : parseStatusUpdate(response.text);
      if (abortSignal.aborted) outcome = 'late';
      else if (!parsed.ok) outcome = `rejected: ${parsed.problem}`;
      else {
        this.previous = parsed.text;
        this.progress.statusUpdate(command.turn, { updateId: randomUUID(), text: parsed.text, createdAtUtc: new Date().toISOString() });
      }
    } catch (error) {
      outcome = abortSignal.aborted ? 'cancelled' : `failed: ${toError(error).message}`;
    }
    this.logger?.write({ kind: 'status_update', turn: command.turn, outcome, elapsedMs: Date.now() - startedAtMs,
      promptCacheTokens: usage.promptCacheTokens ?? null, promptEvalTokens: usage.promptEvalTokens ?? null });
  }
}
