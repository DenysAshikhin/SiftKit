import test from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';
import path from 'node:path';
import type { JsonObject, JsonSerializable } from '../src/lib/json-types.js';
import { runTaskLoop } from '../src/repo-search/engine.js';
import { resolveRepoSearchPlannerToolDefinitions } from '../src/repo-search/planner-protocol.js';
import { TurnCommandResultEventSchema } from '../src/repo-search/live-snapshot/schemas.js';
import { createMockLoopDefaults } from './helpers/mock-loop-defaults.js';
import { parseLoggedEvent } from './helpers/logged-events.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';

test('TurnCommandResultEventSchema accepts a rejected command with a null exit code', () => {
  const parsed = TurnCommandResultEventSchema.safeParse({
    turn: 4,
    toolCallId: 'tc_0',
    command: 'web_search query="x"',
    toolName: 'web_search',
    exitCode: null,
    output: 'Rejected command: No web search provider configured.',
    rejectionKind: 'safety',
    rejectionReason: 'No web search provider configured.',
  });
  assert.equal(parsed.success, true);
  if (!parsed.success) return;
  assert.equal(parsed.data.toolName, 'web_search');
  assert.equal(parsed.data.exitCode, null);
  assert.equal('rejectionKind' in parsed.data && parsed.data.rejectionKind, 'safety');
});

test('TurnCommandResultEventSchema rejects a null-exit result that does not name its rejection kind', () => {
  // Without the kind the collector cannot tell a screened call from a refused one, so an emitter
  // that forgets it must fail loudly here rather than tally toward neither counter.
  const parsed = TurnCommandResultEventSchema.safeParse({
    turn: 4,
    command: 'web_search query="x"',
    exitCode: null,
    output: 'Rejected command: nope',
  });
  assert.equal(parsed.success, false);
});

test('TurnCommandResultEventSchema still accepts a plain executed result', () => {
  const parsed = TurnCommandResultEventSchema.safeParse({
    turn: 1,
    toolCallId: 'tc_0',
    command: 'grep pattern="x"',
    requestedCommand: 'grep pattern="x"',
    executedCommand: 'grep pattern="x"',
    exitCode: 0,
    output: 'hit',
    insertedResultText: 'hit',
    resultTokenCount: 12,
  });
  assert.equal(parsed.success, true);
  if (!parsed.success) return;
  assert.equal('rejectionKind' in parsed.data, false);
  assert.equal(parsed.data.toolName, undefined);
});

test('an executed result that omits the model-visible text it inserted fails to parse', () => {
  // `output` is a mirror for the live snapshot; replay reads `insertedResultText`. An emitter that
  // stops writing it must break here rather than let replay silently fall back to a preview.
  const parsed = TurnCommandResultEventSchema.safeParse({
    turn: 1,
    toolCallId: 'tc_0',
    command: 'grep pattern="x"',
    requestedCommand: 'grep pattern="x"',
    executedCommand: 'grep pattern="x"',
    exitCode: 0,
    output: 'hit',
  });
  assert.equal(parsed.success, false);
});

const REJECTION_LOOP_DEFAULTS = createMockLoopDefaults('siftkit-rejection-transcript-');

test('a rejected read writes a turn_command_result with rejected=true', async () => {
  const repoRoot = createManagedTempDir('siftkit-rejection-repo-');
  fs.writeFileSync(path.join(repoRoot, 'present.ts'), 'export const value = 1;\n', 'utf8');
  const events: JsonObject[] = [];

  const result = await runTaskLoop(
    {
      id: 'task-rejected-read',
      question: 'Read a file that does not exist.',
    },
    {
      ...REJECTION_LOOP_DEFAULTS,
      repoRoot,
      maxTurns: 4,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 0,
      totalContextTokens: 20000,
      plannerToolDefinitions: resolveRepoSearchPlannerToolDefinitions(['read']),
      mockResponses: [
        { toolCalls: [{ name: 'read', arguments: { path: 'absent.ts', offset: 1, limit: 5 } }] },
        { content: 'done' },
      ],
      mockCommandResults: {},
      logger: {
        path: 'memory',
        write(event: Record<string, JsonSerializable>) {
          events.push(parseLoggedEvent(event));
        },
      },
    },
  );

  assert.equal(result.reason, 'finish');
  const results = events.filter((event) => event.kind === 'turn_command_result');
  assert.equal(results.length, 1);
  assert.equal(results[0].rejectionKind, 'safety');
  assert.equal(results[0].exitCode, null);
  assert.equal(results[0].toolName, 'read');
  assert.equal(String(results[0].output).startsWith('Rejected command: '), true);
  // Nothing executed: rejection events must not fake the executed-event mirror fields.
  assert.equal('requestedCommand' in results[0], false);
  assert.equal('executedCommand' in results[0], false);
});
