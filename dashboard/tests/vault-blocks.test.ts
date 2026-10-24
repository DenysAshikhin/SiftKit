import { test } from 'vitest';
import assert from 'node:assert/strict';

import { inlineTokens, pillValue } from '../src/lib/vault-inline.ts';
import { noteBlocks } from '../src/lib/vault-blocks.ts';

test('inlineTokens splits code, emphasis, links and tags and keeps the text between', () => {
  assert.deepEqual(inlineTokens('a `c` **b** *i* _d_ [[T|L]] ![[x.png]] #tag end'), [
    { kind: 'text', text: 'a ' },
    { kind: 'code', text: 'c' },
    { kind: 'text', text: ' ' },
    { kind: 'bold', text: 'b' },
    { kind: 'text', text: ' ' },
    { kind: 'italic', text: 'i' },
    { kind: 'text', text: ' ' },
    { kind: 'dim', text: 'd' },
    { kind: 'text', text: ' ' },
    { kind: 'link', target: 'T', label: 'L', embed: false },
    { kind: 'text', text: ' ' },
    { kind: 'link', target: 'x.png', label: null, embed: true },
    { kind: 'text', text: ' ' },
    { kind: 'tag', tag: 'tag' },
    { kind: 'text', text: ' end' },
  ]);
});

test('inlineTokens leaves a hash inside a word and snake_case alone', () => {
  assert.deepEqual(inlineTokens('a#b snake_case_name'), [{ kind: 'text', text: 'a#b snake_case_name' }]);
  assert.deepEqual(inlineTokens(''), []);
});

test('pillValue turns a lone link into a link pill and anything else into a text pill', () => {
  assert.deepEqual(pillValue(' [[Git|git]] '), { kind: 'link', target: 'Git', label: 'git' });
  assert.deepEqual(pillValue('Dark [[Mode]]'), { kind: 'text', text: 'Dark [[Mode]]' });
});

const BODY = [
  'Lead line with [[Windows]].', // 0
  '', // 1
  '**Uses** [[Git]] · Dark Mode', // 2
  '**Runs on** [[Windows]]', // 3
  '', // 4
  '# Top', // 5
  '### Small', // 6
  '- [ ] Try [[Cursor]]', // 7
  '- [x] Done', // 8
  '- **Owner** [[Bob]]', // 9
  'Second paragraph.', // 10
  '> [!unverified]- 1 unverified fact', // 11
  '> - **Uses** [[GitHub]] #unverified', // 12
  '> [[npm]] · plain', // 13
  '![[a.png]]', // 14
  '![[b.png]]', // 15
  '```', // 16
  '[[NotALink]]', // 17
  '```', // 18
  '> just a quote', // 19
].join('\n');

test('noteBlocks models every dialect element in order', () => {
  assert.deepEqual(noteBlocks(BODY, { limit: 400, full: false }), [
    { kind: 'paragraph', text: 'Lead line with [[Windows]].', lead: true, line: 0 },
    { kind: 'facts', rows: [
      { label: 'Uses', values: ['[[Git]]', 'Dark Mode'], line: 2 },
      { label: 'Runs on', values: ['[[Windows]]'], line: 3 },
    ] },
    { kind: 'heading', level: 2, text: 'Top', line: 5 },
    { kind: 'heading', level: 3, text: 'Small', line: 6 },
    { kind: 'list', items: [
      { kind: 'task', done: false, text: 'Try [[Cursor]]', line: 7 },
      { kind: 'task', done: true, text: 'Done', line: 8 },
      { kind: 'item', label: 'Owner', text: '[[Bob]]', unverified: false, line: 9 },
    ] },
    { kind: 'paragraph', text: 'Second paragraph.', lead: false, line: 10 },
    { kind: 'callout', calloutKind: 'unverified', fold: '-', title: '1 unverified fact', parts: [
      { kind: 'list', items: [{ kind: 'item', label: 'Uses', text: '[[GitHub]] #unverified', unverified: true, line: 12 }] },
      { kind: 'pills', values: ['[[npm]]', 'plain'] },
    ] },
    { kind: 'embeds', targets: ['a.png', 'b.png'] },
    { kind: 'fence', text: '[[NotALink]]' },
    { kind: 'quote', lines: ['just a quote'] },
  ]);
});

test('noteBlocks cuts a long note into a trailing more block unless full', () => {
  const body = Array.from({ length: 10 }, (_, index) => `line ${index}`).join('\n');
  const cut = noteBlocks(body, { limit: 3, full: false });
  assert.equal(cut.length, 4);
  assert.deepEqual(cut.at(-1), { kind: 'more', remaining: 7 });
  assert.equal(noteBlocks(body, { limit: 3, full: true }).length, 10);
});

test('noteBlocks renders a callout with no header line as a plain quote and an empty body as nothing', () => {
  assert.deepEqual(noteBlocks('> a\n> b', { limit: 400, full: false }), [{ kind: 'quote', lines: ['a', 'b'] }]);
  assert.deepEqual(noteBlocks('', { limit: 400, full: false }), []);
});
