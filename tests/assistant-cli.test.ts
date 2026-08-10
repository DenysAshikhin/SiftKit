import assert from 'node:assert/strict';
import test from 'node:test';

import { parseAssistantArgs } from '../src/cli/assistant-args.js';

test('assistant CLI parses every Gate C command exactly', () => {
  assert.deepEqual(parseAssistantArgs(['status']), { kind: 'status' });
  assert.deepEqual(parseAssistantArgs(['pause']), { kind: 'pause' });
  assert.deepEqual(parseAssistantArgs(['resume']), { kind: 'resume' });
  assert.deepEqual(parseAssistantArgs(['memory', 'search', 'PowerShell', 'settings']), {
    kind: 'memory_search', query: 'PowerShell settings', modelIntent: false,
  });
  assert.deepEqual(parseAssistantArgs(['memory', 'search', 'PowerShell', '--model-intent']), {
    kind: 'memory_search', query: 'PowerShell', modelIntent: true,
  });
  assert.deepEqual(parseAssistantArgs(['memory', 'explain', 'ast_1']), {
    kind: 'memory_explain', assertionId: 'ast_1',
  });
  assert.deepEqual(parseAssistantArgs(['memory', 'confirm', 'ast_1']), {
    kind: 'memory_confirm', assertionId: 'ast_1',
  });
  assert.deepEqual(parseAssistantArgs([
    'memory', 'correct', 'ast_1', '--value', '"PowerShell 7"',
  ]), { kind: 'memory_correct', assertionId: 'ast_1', value: 'PowerShell 7' });
  assert.deepEqual(parseAssistantArgs(['memory', 'forget', 'ast_1', '--preview']), {
    kind: 'memory_forget_preview', assertionId: 'ast_1',
  });
  assert.deepEqual(parseAssistantArgs([
    'memory', 'forget', 'ast_1', '--confirm', 'token_1',
  ]), { kind: 'memory_forget_confirm', assertionId: 'ast_1', previewToken: 'token_1' });
  assert.deepEqual(parseAssistantArgs(['policy', 'list']), { kind: 'policy_list' });
  assert.deepEqual(parseAssistantArgs(['policy', 'block-topic', 'finance']), {
    kind: 'policy_block_topic', topic: 'finance',
  });
  assert.deepEqual(parseAssistantArgs(['projections', 'rebuild']), {
    kind: 'projections_rebuild',
  });
});

test('assistant CLI rejects ambiguous, missing, and later-gate commands', () => {
  for (const args of [
    [], ['memory'], ['memory', 'search'], ['memory', 'explain', ''],
    ['memory', 'forget', 'ast_1'],
    ['memory', 'forget', 'ast_1', '--preview', '--confirm', 'token'],
    ['memory', 'correct', 'ast_1'], ['policy', 'block-topic', ''],
    ['capture', 'start'], ['export'], ['backup'], ['wat'],
  ]) {
    assert.throws(() => parseAssistantArgs(args));
  }
});
