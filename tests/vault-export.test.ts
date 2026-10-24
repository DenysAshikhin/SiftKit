import test from 'node:test';
import assert from 'node:assert/strict';

import { toMarkdownFile, vaultExportPath } from '../src/vault/vault-export.ts';
import { TEST_META, entityInput, withVault } from './helpers/vault-fixture.ts';

test('a note exports as frontmatter plus its body under its folder', () => withVault(({ store }) => {
  const note = store.create(entityInput('Visual Studio Code', 'Editor.\n\n**Uses** [[Git]]', { aliases: ['VS Code'], tags: ['Editor'] }), TEST_META);
  assert.equal(vaultExportPath(note), 'Software/Visual Studio Code.md');
  assert.equal(toMarkdownFile(note), [
    '---',
    'kind: entity',
    'types: ["software"]',
    'aliases: ["VS Code"]',
    'tags: ["editor"]',
    'revision: 1',
    'updated: 2026-10-24T09:00:00.000Z',
    '---',
    '',
    'Editor.',
    '',
    '**Uses** [[Git]]',
    '',
  ].join('\n'));
  assert.equal(vaultExportPath(store.create(entityInput('Inbox note', 'x', { folder: '' }), TEST_META)), 'Inbox note.md');
}));
