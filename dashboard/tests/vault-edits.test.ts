import { test } from 'vitest';
import assert from 'node:assert/strict';

import {
  actorClass, contextGroups, fuzzyMatch, insertLink, linkFirstMention, linkQueryAt, outlineOf, rankTitles, toggleTask,
} from '../src/lib/vault-edits.ts';

const summary = (id: string, title: string) => ({ id, title, folder: '', kind: 'entity' as const, isStub: false, updatedAtUtc: '2026-10-24T09:00:00.000Z' });

test('toggleTask flips a checkbox both ways and rejects a non-task line', () => {
  const body = 'Lead\n- [ ] Try it\n  * [X] Done';
  assert.equal(toggleTask(body, 1), 'Lead\n- [x] Try it\n  * [X] Done');
  assert.equal(toggleTask(body, 2), 'Lead\n- [ ] Try it\n  * [ ] Done');
  assert.throws(() => toggleTask(body, 0), /not a task/);
  assert.throws(() => toggleTask(body, 9), /not a task/);
});

test('linkFirstMention wraps the first bare mention and skips existing links', () => {
  assert.equal(linkFirstMention('I use siftkit daily', 'SiftKit'), 'I use [[SiftKit]] daily');
  assert.equal(linkFirstMention('[[SiftKit]] and SiftKit', 'SiftKit'), '[[SiftKit]] and [[SiftKit]]');
  assert.equal(linkFirstMention('Uses C++ a lot', 'C++'), 'Uses [[C++]] a lot');
  assert.equal(linkFirstMention('siftkits are not it', 'SiftKit'), null);
  assert.equal(linkFirstMention('nothing here', 'SiftKit'), null);
});

test('linkQueryAt reads an open [[ query before the caret', () => {
  assert.equal(linkQueryAt('see [[Fo', 8), 'Fo');
  assert.equal(linkQueryAt('see [[', 6), '');
  assert.equal(linkQueryAt('see [[Foo]] x', 13), null);
  assert.equal(linkQueryAt('see [[Fo\no', 10), null);
});

test('insertLink completes the open link and swallows an auto-closed ]]', () => {
  assert.deepEqual(insertLink('see [[Fo', 8, 'Foo'), { value: 'see [[Foo]]', caret: 11 });
  assert.deepEqual(insertLink('see [[Fo]] tail', 8, 'Foo'), { value: 'see [[Foo]] tail', caret: 11 });
});

test('fuzzyMatch is an in-order subsequence test', () => {
  assert.equal(fuzzyMatch('sk', 'siftkit'), true);
  assert.equal(fuzzyMatch('', 'x'), true);
  assert.equal(fuzzyMatch('ks', 'sk'), false);
});

test('rankTitles puts prefix matches first, then higher degree, and honours the limit', () => {
  const entries = [
    { title: 'Visual Sift Studio', degree: 50 },
    { title: 'Sift', degree: 1 },
    { title: 'SiftKit', degree: 9 },
    { title: 'Unrelated', degree: 99 },
  ];
  assert.deepEqual(rankTitles(entries, 'si', 'contains', 12).map((entry) => entry.title), ['SiftKit', 'Sift', 'Visual Sift Studio']);
  assert.deepEqual(rankTitles(entries, 'vs', 'fuzzy', 12).map((entry) => entry.title), ['Visual Sift Studio']);
  assert.deepEqual(rankTitles(entries, '', 'fuzzy', 2).map((entry) => entry.title), ['Unrelated', 'Visual Sift Studio']);
});

test('contextGroups groups backlinks by row label, largest group first', () => {
  const groups = contextGroups([
    { note: summary('a', 'A'), labels: ['Uses'] },
    { note: summary('b', 'B'), labels: [] },
    { note: summary('c', 'C'), labels: ['Uses', 'Owner'] },
  ]);
  assert.deepEqual(groups.map((group) => [group.label, group.notes.map((note) => note.id)]), [
    ['Uses', ['a', 'c']],
    ['Mentioned in', ['b']],
    ['Owner', ['c']],
  ]);
});

test('outlineOf lists headings with the bullet count under each', () => {
  assert.deepEqual(outlineOf('Lead\n## Plans\n- a\n- b\n### Sub\ntext\n# Top'), [
    { line: 1, text: 'Plans', level: 2, items: 2 },
    { line: 4, text: 'Sub', level: 3, items: 0 },
    { line: 6, text: 'Top', level: 1, items: 0 },
  ]);
});

test('actorClass maps each actor to its history colour', () => {
  assert.equal(actorClass('you'), 'v-actor-you');
  assert.equal(actorClass('migration'), 'v-actor-migration');
  assert.equal(actorClass('note-writer · tidy'), 'v-actor-tidy');
  assert.equal(actorClass('capture-intake'), 'v-actor-intake');
  assert.equal(actorClass('note-writer · chat'), 'v-actor-writer');
});
