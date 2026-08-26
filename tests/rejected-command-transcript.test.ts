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
    command: 'web_search query="x"',
    toolName: 'web_search',
    exitCode: null,
    output: 'Rejected command: No web search provider configured.',
    rejected: true,
    rejectionReason: 'No web search provider configured.',
  });
  assert.equal(parsed.success, true);
  if (!parsed.success) return;
  assert.equal(parsed.data.toolName, 'web_search');
  assert.equal(parsed.data.rejected, true);
  assert.equal(parsed.data.exitCode, null);
});

test('TurnCommandResultEventSchema still accepts a plain executed result', () => {
  const parsed = TurnCommandResultEventSchema.safeParse({
    turn: 1,
    command: 'grep pattern="x"',
    exitCode: 0,
    output: 'hit',
    resultTokenCount: 12,
  });
  assert.equal(parsed.success, true);
  if (!parsed.success) return;
  assert.equal(parsed.data.rejected, undefined);
  assert.equal(parsed.data.toolName, undefined);
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
      signals: ['done'],
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
  assert.equal(results[0].rejected, true);
  assert.equal(results[0].exitCode, null);
  assert.equal(results[0].toolName, 'read');
  assert.equal(String(results[0].output).startsWith('Rejected command: '), true);
  // Nothing executed: rejection events must not fake the executed-event mirror fields.
  assert.equal('requestedCommand' in results[0], false);
  assert.equal('executedCommand' in results[0], false);
});
