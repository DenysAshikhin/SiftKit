import assert from 'node:assert/strict';
import test from 'node:test';

import { parseAssistantArgs } from '../src/cli/assistant-args.ts';

test('assistant CLI parses the status commands exactly', () => {
  assert.deepEqual(parseAssistantArgs(['status']), { kind: 'status' });
  assert.deepEqual(parseAssistantArgs(['pause']), { kind: 'pause' });
  assert.deepEqual(parseAssistantArgs(['resume']), { kind: 'resume' });
});

test('assistant CLI rejects missing, ambiguous and retired graph commands', () => {
  for (const args of [
    [], ['status', 'now'], ['memory', 'search', 'PowerShell'], ['policy', 'list'], ['projections', 'rebuild'],
    ['evidence', 'delete', 'ev_1', '--preview'], ['capture', 'start'], ['export'], ['backup'], ['wat'],
  ]) {
    assert.throws(() => parseAssistantArgs(args));
  }
});
