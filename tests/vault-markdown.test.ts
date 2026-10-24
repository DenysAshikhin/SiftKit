import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseFactRow, parseNoteBody, splitValues, vaultKey, VAULT_LINK_PATTERN, VAULT_TAG_PATTERN,
} from '@siftkit/contracts';

const ENTITY = [
  'Visual Studio Code is a tool you use. It runs on [[Windows]].',
  '',
  '**Uses** [[Git]] · [[Node.js|node]] · Dark Mode',
  '**Runs on** [[Windows]]',
  '',
  '## Plans',
  '- [ ] Try [[Cursor]]',
  '- [x] Install #extensions',
  '',
  '> [!more]- 2 more · uses',
  '> [[npm]] · [[Prettier]]',
  '',
  '> [!unverified]- 2 unverified facts',
  '> - **Uses** [[GitHub]] #unverified',
  '> - Likes dark themes #unverified',
  '',
  '![[attachments/captures/ev_1.png]]',
  '```',
  '[[NotALink]] #nottag',
  '```',
  'Inline `[[code]]` is ignored.',
].join('\n');

test('parseNoteBody extracts the lead from the first plain paragraph', () => {
  const parsed = parseNoteBody(ENTITY);
  assert.deepEqual(parsed.lead, { text: 'Visual Studio Code is a tool you use. It runs on [[Windows]].', line: 0 });
});

test('parseNoteBody reads top-level fact rows only', () => {
  const parsed = parseNoteBody(ENTITY);
  assert.deepEqual(parsed.factRows, [
    { label: 'Uses', values: ['[[Git]]', '[[Node.js|node]]', 'Dark Mode'], line: 2 },
    { label: 'Runs on', values: ['[[Windows]]'], line: 3 },
  ]);
});

test('parseNoteBody records links with row labels, skipping code', () => {
  const parsed = parseNoteBody(ENTITY);
  const summary = parsed.links.map((link) => [link.target, link.display, link.rowLabel, link.line, link.embed]);
  assert.deepEqual(summary, [
    ['Windows', null, null, 0, false],
    ['Git', null, 'Uses', 2, false],
    ['Node.js', 'node', 'Uses', 2, false],
    ['Windows', null, 'Runs on', 3, false],
    ['Cursor', null, null, 6, false],
    ['npm', null, null, 10, false],
    ['Prettier', null, null, 10, false],
    ['GitHub', null, 'Uses', 13, false],
    ['attachments/captures/ev_1.png', null, null, 16, true],
  ]);
});

test('parseNoteBody reads tasks, unverified facts, embeds and tags', () => {
  const parsed = parseNoteBody(ENTITY);
  assert.deepEqual(parsed.tasks, [
    { text: 'Try [[Cursor]]', done: false, line: 6 },
    { text: 'Install #extensions', done: true, line: 7 },
  ]);
  assert.deepEqual(parsed.unverified, [
    { label: 'Uses', value: '[[GitHub]]', line: 13 },
    { label: null, value: 'Likes dark themes', line: 14 },
  ]);
  assert.deepEqual(parsed.embeds, ['attachments/captures/ev_1.png']);
  assert.deepEqual(parsed.tags, ['extensions', 'unverified']);
});

test('parseNoteBody handles an empty body and a body without a lead', () => {
  assert.deepEqual(parseNoteBody(''), { lead: null, links: [], tags: [], factRows: [], tasks: [], unverified: [], embeds: [] });
  assert.equal(parseNoteBody('**Uses** [[A]]').lead, null);
});

test('splitValues trims and drops empty parts', () => {
  assert.deepEqual(splitValues(' [[A]] ·  b  · '), ['[[A]]', 'b']);
});

test('vaultKey trims and lowercases a title or alias', () => {
  assert.equal(vaultKey('  Foo Bar '), 'foo bar');
});

test('parseFactRow splits a bold label from its values, else null', () => {
  assert.deepEqual(parseFactRow('**Uses** [[A]] · b'), { label: 'Uses', rest: '[[A]] · b' });
  assert.equal(parseFactRow('plain'), null);
});

test('the shared link and tag patterns match the dialect', () => {
  const links = [...'x [[A|b]] ![[c.png]] #t'.matchAll(VAULT_LINK_PATTERN)];
  assert.deepEqual(links.map((match) => [match[1], match[2], match[3]]), [['', 'A', 'b'], ['!', 'c.png', undefined]]);
  assert.deepEqual([...'x #t y#no'.matchAll(VAULT_TAG_PATTERN)].map((match) => match[1]), ['t']);
});
