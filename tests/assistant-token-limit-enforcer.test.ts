import test from 'node:test';
import assert from 'node:assert/strict';

import type { TokenCounter, TokenCount } from '../src/assistant/domain/tokens.js';
import { TokenLimitEnforcer } from '../src/assistant/projections/token-limit-enforcer.js';

class LengthTokenCounter implements TokenCounter {
  async count(text: string): Promise<TokenCount> {
    return { tokenCount: text.length, tokenizerId: 'length' };
  }
}

class FailingTokenCounter implements TokenCounter {
  async count(_text: string): Promise<TokenCount> {
    throw new Error('count failed');
  }
}

test('returns an unchanged body when it fits', async () => {
  const enforcer = new TokenLimitEnforcer(new LengthTokenCounter());
  const lines = ['# Profile', '', '- Uses PowerShell. [M:ast_1]', ''];
  const result = await enforcer.enforce(lines, 200);
  assert.equal(result.body, lines.join('\n'));
  assert.equal(result.droppedLines, 0);
});

test('drops cited lines from the end until the body fits', async () => {
  const enforcer = new TokenLimitEnforcer(new LengthTokenCounter());
  const lines = [
    '# Profile',
    '',
    '- Uses PowerShell. [M:ast_1]',
    '- Uses Bash. [M:ast_2]',
    '- Uses Zsh. [M:ast_3]',
    '',
  ];
  const result = await enforcer.enforce(lines, 40);
  assert.ok(!result.body.includes('ast_3'), 'last cited line must be dropped');
  assert.ok(!result.body.includes('ast_2'), 'second cited line must also be dropped');
  assert.ok(result.body.includes('ast_1'), 'first cited line must remain');
  assert.equal(result.droppedLines, 2);
});

test('does not mutate the input lines', async () => {
  const enforcer = new TokenLimitEnforcer(new LengthTokenCounter());
  const lines = ['# Profile', '', '- Uses PowerShell. [M:ast_1]', '- Uses Bash. [M:ast_2]', ''];
  const snapshot = [...lines];
  await enforcer.enforce(lines, 20);
  assert.deepEqual(lines, snapshot);
});

test('stops when no removable cited line remains', async () => {
  const enforcer = new TokenLimitEnforcer(new LengthTokenCounter());
  const lines = ['# Profile', '', 'no cited line here', ''];
  const result = await enforcer.enforce(lines, 5);
  assert.equal(result.body, lines.join('\n'));
  assert.equal(result.droppedLines, 0);
});

test('propagates token-counter failures', async () => {
  const enforcer = new TokenLimitEnforcer(new FailingTokenCounter());
  const lines = ['# Profile', '', '- Uses PowerShell. [M:ast_1]', ''];
  await assert.rejects(enforcer.enforce(lines, 200), /count failed/);
});