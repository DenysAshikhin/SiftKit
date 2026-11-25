import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import Database from 'better-sqlite3';

import { JsonObjectSchema } from '../src/lib/json-types.ts';
import { parseJsonValueText } from '../src/lib/json.ts';
import { SilentProgressWriter } from '../src/lib/progress-writer.ts';
import { z } from '../src/lib/zod.ts';
import { ProgressReporter } from '../src/repo-search/engine/progress-reporter.ts';
import { PromptCacheWatch } from '../src/repo-search/engine/prompt-cache-watch.ts';
import { buildStatusUpdateInstruction, parseStatusUpdate, StatusUpdates, type StatusUpdateRequester } from '../src/repo-search/engine/status-updates.ts';
import { resolvePlannerThinkingFlags } from '../src/repo-search/engine/task-loop-support.ts';
import { PlannerChatMessagesSchema, type ChatMessage } from '../src/repo-search/planner-chat-message.ts';
import {
  captureExecutingPlannerRequest, requestRepoSearchPlannerProtocolAction, requestStatusUpdate, serializeProtocolMessages,
  type ExecutingPlannerRequest, type PlannerActionResponse,
} from '../src/repo-search/planner-protocol.ts';
import { TEST_THROUGHPUT_AUDIT_OPERATION } from './_test-helpers.ts';
import { LIVE_REQUEST_TIMEOUT_MS, loadLivePlannerFixture, type LivePlannerFixture } from './helpers/live-planner-fixture.ts';

const GATE_ENABLED = process.env.SIFTKIT_TEST_LIVE_STATUS_UPDATES === '1';
const PRESET_ID = 'exl3-3-8-27b-5bpw';
const CONVERSATIONS = 10;
/** Prompt sizes measured in each conversation, with how far past each a turn may lie. */
const PROMPT_SIZES = [20_000, 50_000, 80_000, 110_000] as const;
const SIZE_TOLERANCE = 1.09;
const PLANNER_MAX_TOKENS = 8;
const WINDOW_MS = 3_000;
const COMMAND = 'npm test';

const TurnSchema = z.object({ kind: z.literal('turn_new_messages'), turn: z.number().int().positive(), messages: PlannerChatMessagesSchema, promptTokenCount: z.number().positive() });
const RunRowSchema = z.object({ run_id: z.string(), transcript: z.string() });
const RUN_LOGS_SQL = `SELECT run_id, repo_search_transcript_jsonl AS transcript FROM run_logs
  WHERE operation_type = 'repo-agent' AND (model IS NULL OR model NOT IN ('mock', 'test-model')) AND length(repo_search_transcript_jsonl) > 500000
  ORDER BY started_at_utc DESC`;

/** One place in a recorded run: the planner request sent there, and the next one, after its command. */
type Point = { before: ChatMessage[]; after: ChatMessage[]; beforeTokens: number; afterTokens: number };
type Arm = 'none' | 'completed' | 'cancelled';
type Sample = { size: number; arm: Arm; evalTokens: number; nextElapsedMs: number; updateElapsedMs: number; settleMs: number; broke: boolean; shown: boolean };

/** The points a recorded run offers before its first compaction, or null when it misses a size. */
function pointsOf(transcript: string): Point[] | null {
  const turns: z.infer<typeof TurnSchema>[] = [];
  for (const line of transcript.split('\n')) {
    if (line.trim() === '') continue;
    const event = JsonObjectSchema.parse(parseJsonValueText(line));
    if (event.kind === 'prompt_cache_epoch_reset') break;
    const turn = TurnSchema.safeParse(event);
    if (turn.success) turns.push(turn.data);
  }
  const points: Point[] = [];
  for (const size of PROMPT_SIZES) {
    const index = turns.findIndex((turn) => turn.promptTokenCount >= size);
    const before = turns[index];
    const after = turns[index + 1];
    if (before === undefined || after === undefined || before.promptTokenCount > size * SIZE_TOLERANCE) return null;
    points.push({
      before: turns.slice(0, index + 1).flatMap((turn) => turn.messages), after: turns.slice(0, index + 2).flatMap((turn) => turn.messages),
      beforeTokens: before.promptTokenCount, afterTokens: after.promptTokenCount,
    });
  }
  return points;
}

function recordedConversations(): Point[][] {
  const database = new Database(path.resolve('.siftkit/runtime.sqlite'), { readonly: true });
  try {
    const found: Point[][] = [];
    for (const row of database.prepare(RUN_LOGS_SQL).iterate()) {
      const points = pointsOf(RunRowSchema.parse(row).transcript);
      if (points !== null) found.push(points);
      if (found.length === CONVERSATIONS) break;
    }
    return found;
  } finally {
    database.close();
  }
}

/** One copy of a recorded conversation against the live engine; its tag keeps it apart from every other copy's cache. */
class Replay implements StatusUpdateRequester {
  private readonly fixture: LivePlannerFixture;
  private readonly tag = `Copy ${randomUUID()}.\n`;
  private executing: ExecutingPlannerRequest | null = null;

  constructor(fixture: LivePlannerFixture) {
    this.fixture = fixture;
  }

  async plan(messages: readonly ChatMessage[], promptTokens: number): Promise<PlannerActionResponse> {
    const [system, ...rest] = messages;
    assert.ok(system && typeof system.content === 'string');
    const { config, baseUrl, model, tools } = this.fixture;
    const flags = resolvePlannerThinkingFlags(config);
    const serialized = serializeProtocolMessages([{ ...system, content: this.tag + system.content }, ...rest], flags.reasoningContentEnabled);
    this.executing = captureExecutingPlannerRequest(serialized, flags, tools, promptTokens);
    return requestRepoSearchPlannerProtocolAction({ config, baseUrl, model, throughputAudit: TEST_THROUGHPUT_AUDIT_OPERATION, messages: serialized,
      timeoutMs: LIVE_REQUEST_TIMEOUT_MS, totalDeadlineMs: LIVE_REQUEST_TIMEOUT_MS, maxTokens: PLANNER_MAX_TOKENS, ...flags, stage: 'planner_action', responseSchema: null, tools });
  }

  requestStatusUpdate(instruction: string, abortSignal: AbortSignal): Promise<PlannerActionResponse> {
    assert.ok(this.executing);
    const { config, baseUrl, model } = this.fixture;
    return requestStatusUpdate({ config, baseUrl, model, throughputAudit: TEST_THROUGHPUT_AUDIT_OPERATION, executing: this.executing, instruction, abortSignal });
  }
}

function evalTokens(response: PlannerActionResponse): number {
  assert.ok(typeof response.promptEvalTokens === 'number', 'the engine reports how many prompt tokens it read');
  return response.promptEvalTokens;
}

/** The planner turn, its three-second command with or without an update, and the planner turn after it. */
async function measure(replay: Replay, point: Point, size: number, arm: Arm): Promise<Sample> {
  const watch = new PromptCacheWatch();
  const first = await replay.plan(point.before, point.beforeTokens);
  watch.observe({ turn: 1, promptTokens: point.beforeTokens, promptEvalTokens: evalTokens(first), promptCacheTokens: null });
  let updateElapsedMs = 0;
  let settleMs = 0;
  let shown = false;
  if (arm === 'completed') {
    await delay(WINDOW_MS);
    const startedAt = performance.now();
    const reply = await replay.requestStatusUpdate(buildStatusUpdateInstruction({ command: COMMAND, recent: [], previous: null }), new AbortController().signal);
    updateElapsedMs = performance.now() - startedAt;
    shown = reply.toolCalls.length === 0 && parseStatusUpdate(reply.text).ok;
  } else if (arm === 'cancelled') {
    const progress = new ProgressReporter({ progressWriter: new SilentProgressWriter(), taskId: 'gate', maxTurns: 1, taskStartedAt: Date.now() });
    const updates = new StatusUpdates({ requester: replay, progress, logger: null });
    updates.toolStarted({ turn: 1, toolName: 'run', activityKind: 'validate', command: COMMAND });
    await delay(WINDOW_MS + 250 + Math.random() * 1_750);
    updates.toolFinished();
    const endedAt = performance.now();
    await updates.settle();
    settleMs = performance.now() - endedAt;
  } else {
    await delay(WINDOW_MS);
  }
  const startedAt = performance.now();
  const next = await replay.plan(point.after, point.afterTokens);
  const broke = watch.observe({ turn: 2, promptTokens: point.afterTokens, promptEvalTokens: evalTokens(next), promptCacheTokens: null }) !== null;
  return { size, arm, evalTokens: evalTokens(next), nextElapsedMs: performance.now() - startedAt, updateElapsedMs, settleMs, broke, shown };
}

function p90(values: readonly number[]): number {
  const value = [...values].sort((left, right) => left - right)[Math.ceil(values.length * 0.9) - 1];
  assert.ok(value !== undefined, 'nothing was measured');
  return Math.round(value);
}

test('status updates cost the run nothing it can notice', {
  timeout: 6 * 3_600_000,
  skip: GATE_ENABLED ? false : 'set SIFTKIT_TEST_LIVE_STATUS_UPDATES=1 with the engine idle',
}, async (t) => {
  const fixture = await loadLivePlannerFixture();
  assert.equal(fixture.preset.id, PRESET_ID, 'the gate is defined for this preset');
  const conversations = recordedConversations();
  assert.equal(conversations.length, CONVERSATIONS, 'enough recorded runs reach every size before compacting');
  const samples: Sample[] = [];
  for (const points of conversations) {
    for (const arm of ['none', 'completed', 'cancelled'] as const) {
      const replay = new Replay(fixture);
      for (const [index, point] of points.entries()) {
        const sample = await measure(replay, point, PROMPT_SIZES[index] ?? 0, arm);
        samples.push(sample);
        t.diagnostic(JSON.stringify(sample));
      }
    }
  }

  const of = (arm: Arm): Sample[] => samples.filter((sample) => sample.arm === arm);
  const baseline = of('none');
  const extra = (arm: Arm, value: (sample: Sample) => number): number => p90(of(arm).map((sample, index) => {
    const control = baseline[index];
    assert.ok(control && control.size === sample.size);
    return value(sample) - value(control);
  }));
  const result = {
    completeP90Ms: p90(of('completed').map((sample) => sample.updateElapsedMs)),
    extraReadAfterCompletedP90: extra('completed', (sample) => sample.evalTokens),
    extraReadAfterCancelledP90: extra('cancelled', (sample) => sample.evalTokens),
    delayP90Ms: p90(of('cancelled').map((sample) => sample.settleMs)),
    breaks: samples.filter((sample) => sample.arm !== 'none' && sample.broke).length,
    // Reported, not gated: how much longer the next planner turn took, and how many replies could be shown.
    nextTurnExtraP90Ms: { completed: extra('completed', (sample) => sample.nextElapsedMs), cancelled: extra('cancelled', (sample) => sample.nextElapsedMs) },
    shown: of('completed').filter((sample) => sample.shown).length,
  };
  t.diagnostic(JSON.stringify(result, null, 2));
  assert.equal(of('completed').length, 40);
  assert.ok(result.completeP90Ms <= 6_000, `an update takes ${result.completeP90Ms} ms`);
  assert.ok(result.extraReadAfterCompletedP90 <= 500 && result.extraReadAfterCancelledP90 <= 500,
    `the next turn reads ${result.extraReadAfterCompletedP90} / ${result.extraReadAfterCancelledP90} tokens more`);
  assert.ok(result.delayP90Ms <= 250, `the next turn starts ${result.delayP90Ms} ms later`);
  assert.equal(result.breaks, 0, 'no update breaks the prompt cache');
});
