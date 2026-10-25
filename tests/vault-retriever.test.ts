import test from 'node:test';
import assert from 'node:assert/strict';

import type { TokenCount, TokenCounter } from '../src/assistant/domain/tokens.ts';
import { ensureOwnerNote } from '../src/vault/owner-identity.ts';
import { VaultRetriever } from '../src/vault/vault-retriever.ts';
import { TEST_META, entityInput, withVaultAsync } from './helpers/vault-fixture.ts';

/** One token per character, counting calls, so budgets in tests are exact. */
class CharacterTokenCounter implements TokenCounter {
  calls = 0;

  async count(text: string): Promise<TokenCount> {
    this.calls += 1;
    return { tokenCount: text.length, tokenizerId: 'chars' };
  }
}

const UNLIMITED = { maxContextTokens: 100_000, maxNotes: 10 };

test('the owner lead comes first, then matching entity notes with lead and fact rows, links as plain text', async () => {
  await withVaultAsync(async (context) => {
    const owner = ensureOwnerNote(context.store, context.database, 'Denys', TEST_META);
    context.store.update(owner.id, { body: 'This is you.\n\n**Uses** [[Visual Studio Code]]' }, owner.revision, TEST_META);
    context.store.create(entityInput('Visual Studio Code', 'Your editor.\n\n**Extensions** [[GitLens|Git lens]] · Vim\n\n> [!unverified]- 1 unverified fact\n> - **Theme** Dark #unverified', { aliases: ['vscode'] }), TEST_META);
    context.store.create(entityInput('Discord', 'Chat app.'), TEST_META);
    context.store.create(entityInput('2026-10-24 09.00.00 · Visual Studio Code', 'vscode screenshot', { kind: 'capture', folder: 'Captures/2026-10-24', types: [] }), TEST_META);

    const result = await new VaultRetriever({ database: context.database, tokens: new CharacterTokenCounter() }).retrieve('How do I set up vscode keybindings?', UNLIMITED);
    assert.equal(result.renderedBlock, [
      '## Relevant personal context',
      '',
      '### Denys (you)',
      'This is you.',
      '',
      '### Visual Studio Code',
      'Your editor.',
      '**Extensions** Git lens · Vim',
    ].join('\n'));
    assert.equal(result.tokenCount, result.renderedBlock.length);
    assert.equal(result.noteIds.length, 2);
  });
});

test('the owner block carries its fact rows when the owner note itself matches', async () => {
  await withVaultAsync(async (context) => {
    const owner = ensureOwnerNote(context.store, context.database, 'Denys', TEST_META);
    context.store.update(owner.id, { body: 'This is you.\n\n**Prefers** tea' }, owner.revision, TEST_META);
    const result = await new VaultRetriever({ database: context.database, tokens: new CharacterTokenCounter() }).retrieve('Do I like tea?', UNLIMITED);
    assert.equal(result.renderedBlock, '## Relevant personal context\n\n### Denys (you)\nThis is you.\n**Prefers** tea');
  });
});

test('notes are fitted to the token budget by binary search, with logarithmic tokenizer calls', async () => {
  await withVaultAsync(async (context) => {
    for (let index = 0; index < 40; index += 1) {
      context.store.create(entityInput(`Budget Tool ${String(index).padStart(2, '0')}`, `Budget tool number ${index}.`), TEST_META);
    }
    const tokens = new CharacterTokenCounter();
    const retriever = new VaultRetriever({ database: context.database, tokens });
    const all = await retriever.retrieve('budget tool', { maxContextTokens: 100_000, maxNotes: 40 });
    assert.equal(all.noteIds.length, 40);
    const budget = Math.floor(all.tokenCount / 2);
    tokens.calls = 0;
    const fitted = await retriever.retrieve('budget tool', { maxContextTokens: budget, maxNotes: 40 });
    assert.ok(fitted.tokenCount <= budget && fitted.noteIds.length > 0 && fitted.noteIds.length < 40);
    assert.deepEqual(fitted.noteIds, all.noteIds.slice(0, fitted.noteIds.length), 'a prefix of the ranked notes');
    assert.ok(tokens.calls <= 8, `expected O(log n) tokenizer calls, got ${tokens.calls}`);
    assert.equal((await retriever.retrieve('budget tool', { maxContextTokens: 100_000, maxNotes: 3 })).noteIds.length, 3);
  });
});

test('nothing is rendered without an owner note or matches, or when even the owner block is over budget', async () => {
  await withVaultAsync(async (context) => {
    const retriever = new VaultRetriever({ database: context.database, tokens: new CharacterTokenCounter() });
    assert.deepEqual(await retriever.retrieve('anything at all', UNLIMITED), { renderedBlock: '', noteIds: [], tokenCount: 0 });
    ensureOwnerNote(context.store, context.database, 'Denys', TEST_META);
    assert.deepEqual(await retriever.retrieve('anything', { maxContextTokens: 10, maxNotes: 10 }), { renderedBlock: '', noteIds: [], tokenCount: 0 });
  });
});
