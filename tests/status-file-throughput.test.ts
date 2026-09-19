import assert from 'node:assert/strict';
import test from 'node:test';

import { parseStatusMetadata } from '../src/status-server/status-file.js';
import { readTabbyThroughput } from '../src/lib/inference-throughput.js';

function parseTerminal(extra: object) {
  return parseStatusMetadata(JSON.stringify({
    requestId: 'req-1',
    running: false,
    terminalState: 'completed',
    ...extra,
  }));
}

test('terminal status metadata carries the canonical throughput fold and its durations', () => {
  const throughput = readTabbyThroughput({ usage: {
    prompt_tokens: 123, prompt_tokens_details: { cached_tokens: 100 },
    prompt_time: 0.05, prompt_tokens_per_sec: 460,
    completion_tokens: 45, completion_time: 0.25, completion_tokens_per_sec: 180,
  } });
  const metadata = parseTerminal({ throughput, promptEvalDurationMs: 50, generationDurationMs: 250 });
  assert.deepEqual(metadata.throughput, throughput);
  assert.equal(metadata.promptEvalDurationMs, 50);
  assert.equal(metadata.generationDurationMs, 250);
});

// A run that never measured (mock provider, failed before inference) reports null, never zeros.
test('missing or malformed throughput metadata reads as null', () => {
  assert.equal(parseTerminal({}).throughput, null);
  assert.equal(parseTerminal({}).promptEvalDurationMs, null);
  assert.equal(parseTerminal({}).generationDurationMs, null);
  assert.equal(parseTerminal({ throughput: { pp: {}, decode: {} } }).throughput, null);
  assert.equal(parseTerminal({ throughput: 'fast' }).throughput, null);
  assert.equal(parseTerminal({ promptEvalDurationMs: -1, generationDurationMs: 'slow' }).promptEvalDurationMs, null);
  assert.equal(parseTerminal({ promptEvalDurationMs: -1, generationDurationMs: 'slow' }).generationDurationMs, null);
});
