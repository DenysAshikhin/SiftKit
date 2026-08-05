import test from 'node:test';
import assert from 'node:assert/strict';

import { renderFrontmatter, parseFrontmatter } from '../src/assistant/projections/frontmatter.js';
import { renderAssertionSentence } from '../src/assistant/projections/assertion-sentence.js';
import { RELATION_TYPES } from '../src/assistant/domain/relation-types.js';

test('frontmatter round-trips every stable field', () => {
  const rendered = renderFrontmatter({
    projectionId: 'memproj_1',
    tier: 2,
    topicKey: 'local-llm-environment',
    generatedAtUtc: '2026-08-05T15:00:00.000Z',
    graphVersion: 184,
    tokenizerId: 'estimate',
    tokenCount: 8421,
    sensitivity: 'personal',
    includedAssertionIds: ['ast_1', 'ast_2'],
  });
  assert.ok(rendered.startsWith('---\n'));
  assert.ok(rendered.includes('generated: true'));
  assert.ok(rendered.includes('do_not_edit: true'));
  const parsed = parseFrontmatter(rendered);
  assert.equal(parsed.projectionId, 'memproj_1');
  assert.equal(parsed.tier, 2);
  assert.equal(parsed.graphVersion, 184);
  assert.deepEqual(parsed.includedAssertionIds, ['ast_1', 'ast_2']);
});

test('an explicit active assertion renders as a plain cited sentence', () => {
  assert.equal(
    renderAssertionSentence({
      assertionId: 'ast_01',
      subjectText: 'the user',
      subjectIsOwner: true,
      predicate: 'USES',
      objectText: 'PowerShell',
      scopeText: '',
      status: 'active',
      basis: 'explicit_user_statement',
      confidence: 0.95,
    }),
    '- Uses PowerShell. [M:ast_01]',
  );
});

test('a scope becomes a qualifier rather than a separate line', () => {
  assert.equal(
    renderAssertionSentence({
      assertionId: 'ast_02',
      subjectText: 'the user',
      subjectIsOwner: true,
      predicate: 'PREFERS',
      objectText: 'PowerShell',
      scopeText: 'Windows command examples',
      status: 'active',
      basis: 'explicit_user_statement',
      confidence: 0.95,
    }),
    '- Prefers PowerShell, for Windows command examples. [M:ast_02]',
  );
});

test('an inferred assertion is labelled and carries its confidence', () => {
  assert.equal(
    renderAssertionSentence({
      assertionId: 'ast_04',
      subjectText: 'the user',
      subjectIsOwner: true,
      predicate: 'USES',
      objectText: 'Visual Studio Code',
      scopeText: '',
      status: 'active',
      basis: 'assistant_inference',
      confidence: 0.72,
    }),
    '- Inferred, not confirmed: uses Visual Studio Code. Confidence 0.72. [M:ast_04]',
  );
});

test('a disputed assertion is always labelled uncertain', () => {
  assert.ok(
    renderAssertionSentence({
      assertionId: 'ast_05',
      subjectText: 'the user',
      subjectIsOwner: true,
      predicate: 'DRIVES',
      objectText: 'a Golf',
      scopeText: '',
      status: 'disputed',
      basis: 'explicit_user_statement',
      confidence: 0.6,
    }).startsWith('- Disputed:'),
  );
});

test('a non-owner subject is named in the line', () => {
  assert.equal(
    renderAssertionSentence({
      assertionId: 'ast_06',
      subjectText: 'SiftKit',
      subjectIsOwner: false,
      predicate: 'DEPENDS_ON',
      objectText: 'better-sqlite3',
      scopeText: '',
      status: 'active',
      basis: 'explicit_user_statement',
      confidence: 0.9,
    }),
    '- SiftKit depends on better-sqlite3. [M:ast_06]',
  );
});

test('every registered predicate has a phrase', () => {
  for (const predicate of RELATION_TYPES) {
    const line = renderAssertionSentence({
      assertionId: 'ast_x', subjectText: 'the user', subjectIsOwner: true, predicate,
      objectText: 'something', scopeText: '', status: 'active',
      basis: 'explicit_user_statement', confidence: 0.9,
    });
    assert.ok(line.includes('[M:ast_x]'));
    assert.ok(!line.includes('undefined'), `${predicate} has no phrase`);
  }
});