import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createManagedTempDir } from '../helpers/temp-dirs.js';
import {
  ChatReplayMemoryConfigSchema, PERFORMANCE_TOOL_RESULTS, REPLAY_MEMORY_CHILD_ENV, runChatReplayMemoryProcess, spawnChatReplayMemoryProcess,
} from '../helpers/chat-replay-memory-process.js';

/** Peak RSS growth a clean process may show while replaying the ~28 MB incident fixture. */
const REPLAY_RSS_BUDGET_BYTES = 192 * 1024 * 1024;

const MIB = 1024 * 1024;

const childConfig = process.env[REPLAY_MEMORY_CHILD_ENV];
if (childConfig !== undefined) {
  runChatReplayMemoryProcess(ChatReplayMemoryConfigSchema.parse(JSON.parse(childConfig)));
} else {

test('incident-scale replay stays within its memory budget in a clean process', { timeout: 300_000 }, t => {
  const runtimeRoot = createManagedTempDir('chat-replay-memory-');
  const entrypoint = fileURLToPath(import.meta.url);
  const generated = spawnChatReplayMemoryProcess(entrypoint, { mode: 'generate', runtimeRoot });
  assert.equal(generated.mode, 'generate');
  assert.ok(generated.journalBytes > 8 * MIB, `journal must exceed 8 MiB, got ${String(generated.journalBytes)}`);

  const replayed = spawnChatReplayMemoryProcess(entrypoint, { mode: 'replay', runtimeRoot, operationId: generated.operationId });
  assert.equal(replayed.mode, 'replay');
  assert.equal(replayed.toolResults, PERFORMANCE_TOOL_RESULTS);
  assert.equal(replayed.historyStatus, 'recovery_needed');
  assert.ok(replayed.snapshotMessages > PERFORMANCE_TOOL_RESULTS);
  const sampledDelta = replayed.rssPeakBytes - replayed.rssBaselineBytes;
  const peakDelta = replayed.maxRssAfterBytes - replayed.maxRssBeforeBytes;
  t.diagnostic(`node=${replayed.nodeVersion} journal_mib=${(replayed.journalBytes / MIB).toFixed(1)}`
    + ` retained_context_mib=${(replayed.retainedContextBytes / MIB).toFixed(1)} retained_rows_mib=${(replayed.retainedRowBytes / MIB).toFixed(1)}`
    + ` rss_baseline_mib=${(replayed.rssBaselineBytes / MIB).toFixed(1)} rss_peak_mib=${(replayed.rssPeakBytes / MIB).toFixed(1)}`
    + ` max_rss_before_mib=${(replayed.maxRssBeforeBytes / MIB).toFixed(1)} max_rss_after_mib=${(replayed.maxRssAfterBytes / MIB).toFixed(1)}`
    + ` sampled_delta_mib=${(sampledDelta / MIB).toFixed(1)} peak_delta_mib=${(peakDelta / MIB).toFixed(1)}`
    + replayed.rssAfterStepBytes.map(([step, rss]) => ` rss_after_${step}_mib=${(rss / MIB).toFixed(1)}`).join(''));
  assert.ok(Math.max(sampledDelta, peakDelta) <= REPLAY_RSS_BUDGET_BYTES,
    `replay grew RSS by ${(Math.max(sampledDelta, peakDelta) / MIB).toFixed(1)} MiB, over the ${String(REPLAY_RSS_BUDGET_BYTES / MIB)} MiB budget`);
});

}
