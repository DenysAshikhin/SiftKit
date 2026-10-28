import test from 'node:test';
import assert from 'node:assert/strict';

import {
  addTasks, addUnverified, appendSectionLines, findRowValue, insertSectionLines, mergeEntityDraft, removeCallouts, replaceSection, resolveUnverified, sectionLines,
} from '@siftkit/contracts';

const BODY = [
  'Lead.',
  '',
  '**Uses** [[Git]]',
  '',
  '## Plans',
  '- [ ] Ship it',
  '',
  '> [!unverified]- 2 unverified facts',
  '> - **Uses** [[GitHub]] #unverified',
  '> - **Prefers** Dark mode #unverified',
].join('\n');

test('Keep on a plain unverified fact moves it into its row and decrements the header', () => {
  assert.deepEqual(resolveUnverified(BODY, 8, 'confirm'), { body: [
    'Lead.', '', '**Uses** [[Git]] · [[GitHub]]', '', '## Plans', '- [ ] Ship it', '',
    '> [!unverified]- 1 unverified fact', '> - **Prefers** Dark mode #unverified',
  ].join('\n'), validated: null });
});

test('keeping the last unverified fact removes the callout and creates a new row', () => {
  const once = resolveUnverified(BODY, 8, 'confirm').body;
  assert.equal(resolveUnverified(once, 8, 'confirm').body, 'Lead.\n\n**Uses** [[Git]] · [[GitHub]]\n**Prefers** Dark mode\n\n## Plans\n- [ ] Ship it');
});

test('resolveUnverified rejects a line that is not an unverified fact', () => {
  assert.throws(() => resolveUnverified(BODY, 2, 'drop'), /Line 2 is not an unverified fact/);
});

test('Drop on a plain unverified fact removes it with header bookkeeping', () => {
  assert.match(resolveUnverified(BODY, 9, 'drop').body, /> \[!unverified\]- 1 unverified fact\n> - \*\*Uses\*\* \[\[GitHub\]\] #unverified$/);
});

const FLAGGED = [
  'Denys builds tools.',
  '',
  '**Editor** [[Neovim]] · Vim',
  '**Hobby** flying by flapping hands · chess',
].join('\n');
const flaggedLine = (body: string) => body.split('\n').findIndex((candidate) => candidate.includes('#unverified'));

test('addUnverified writes a conflict or doubt flag, and a doubt may name a value the row already holds', () => {
  const body = addUnverified(FLAGGED, [
    { label: 'Editor', value: 'Helix', flag: { kind: 'replaces', value: 'Neovim' } },
    { label: 'Hobby', value: 'flying by flapping hands', flag: { kind: 'doubt', reason: 'implausible' } },
  ]);
  assert.match(body, /^> - \*\*Editor\*\* Helix #unverified \(replaces: Neovim\)$/m);
  assert.match(body, /^> - \*\*Hobby\*\* flying by flapping hands #unverified \(doubt: implausible\)$/m);
  assert.match(body, /^> \[!unverified\]- 2 unverified facts$/m);
});

test('Keep on a conflict replaces the old value in its row; Drop only removes the flag', () => {
  const flagged = addUnverified(FLAGGED, [{ label: 'Editor', value: 'Helix', flag: { kind: 'replaces', value: 'Neovim' } }]);
  const kept = resolveUnverified(flagged, flaggedLine(flagged), 'confirm');
  assert.match(kept.body, /^\*\*Editor\*\* Helix · Vim$/m);
  assert.doesNotMatch(kept.body, /#unverified/);
  assert.equal(kept.validated, null);
  assert.equal(resolveUnverified(flagged, flaggedLine(flagged), 'drop').body, FLAGGED);
});

test('Keep on a conflict whose old value is gone adds the new value to the row', () => {
  const flagged = addUnverified(FLAGGED, [{ label: 'Editor', value: 'Helix', flag: { kind: 'replaces', value: 'Emacs' } }]);
  assert.match(resolveUnverified(flagged, flaggedLine(flagged), 'confirm').body, /^\*\*Editor\*\* \[\[Neovim\]\] · Vim · Helix$/m);
});

test('Keep on a doubt removes the flag and reports the value validated; Drop removes the flag and the value', () => {
  const flagged = addUnverified(FLAGGED, [{ label: 'Hobby', value: 'flying by flapping hands', flag: { kind: 'doubt', reason: 'implausible' } }]);
  const kept = resolveUnverified(flagged, flaggedLine(flagged), 'confirm');
  assert.equal(kept.body, FLAGGED);
  assert.deepEqual(kept.validated, { label: 'Hobby', value: 'flying by flapping hands' });
  const dropped = resolveUnverified(flagged, flaggedLine(flagged), 'drop');
  assert.match(dropped.body, /^\*\*Hobby\*\* chess$/m);
  assert.equal(dropped.validated, null);
});

test("Drop on a doubt about a row's only value removes the row", () => {
  const body = 'Lead.\n\n**Hobby** juggling';
  const flagged = addUnverified(body, [{ label: 'Hobby', value: 'juggling', flag: { kind: 'doubt', reason: 'stale' } }]);
  assert.equal(resolveUnverified(flagged, flaggedLine(flagged), 'drop').body, 'Lead.');
});

test('findRowValue matches a linked value by its plain name, ignoring case, and returns it as stored', () => {
  assert.deepEqual(findRowValue(FLAGGED, 'editor', 'neovim'), { label: 'Editor', value: '[[Neovim]]' });
  assert.equal(findRowValue(FLAGGED, 'Editor', 'Helix'), null);
  assert.equal(findRowValue(FLAGGED, 'Missing', 'Vim'), null);
});

test('addTasks appends under an existing heading or creates the section before callouts', () => {
  assert.match(addTasks(BODY, 'Plans', ['Ship it', 'Write docs']), /## Plans\n- \[ \] Ship it\n- \[ \] Write docs\n\n> \[!unverified\]/);
  assert.match(addTasks(BODY, 'Goals', ['Learn Rust']), /- \[ \] Ship it\n\n## Goals\n- \[ \] Learn Rust\n\n> \[!unverified\]/);
});

test('addUnverified skips facts already present as rows or unverified lines', () => {
  const next = addUnverified(BODY, [{ label: 'Uses', value: '[[Git]]', flag: null }, { label: 'Uses', value: '[[github]]', flag: null }, { label: 'Owns', value: '[[PC]]', flag: null }]);
  assert.match(next, /> \[!unverified\]- 3 unverified facts\n> - \*\*Uses\*\* \[\[GitHub\]\] #unverified\n> - \*\*Prefers\*\* Dark mode #unverified\n> - \*\*Owns\*\* \[\[PC\]\] #unverified$/);
  assert.equal(addUnverified('Lead.', [{ label: 'Uses', value: 'x', flag: null }]), 'Lead.\n\n> [!unverified]- 1 unverified fact\n> - **Uses** x #unverified');
});

test('mergeEntityDraft keeps an existing lead and unions rows, tasks and unverified facts', () => {
  const merged = mergeEntityDraft(BODY, {
    lead: 'Other lead.',
    rows: [{ label: 'Uses', values: ['[[Git]]', '[[npm]]'] }],
    taskSections: [{ heading: 'Plans', items: ['Ship it', 'Celebrate'] }],
    unverified: [{ label: 'Owns', value: '[[PC]]', flag: null }],
  });
  assert.match(merged, /^Lead\.\n\n\*\*Uses\*\* \[\[Git\]\] · \[\[npm\]\]/);
  assert.match(merged, /- \[ \] Ship it\n- \[ \] Celebrate/);
  assert.match(merged, /> - \*\*Owns\*\* \[\[PC\]\] #unverified$/);
  assert.equal(mergeEntityDraft('', { lead: 'New lead.', rows: [], taskSections: [], unverified: [] }), 'New lead.');
});

test('appendSectionLines adds deduplicated lines to an existing section or a new one at the end', () => {
  const body = ['Lead.', '', '## Learned', '- a', '', '## Chats', '- c'].join('\n');
  assert.equal(appendSectionLines(body, 'Learned', ['- a', '- b']), ['Lead.', '', '## Learned', '- a', '- b', '', '## Chats', '- c'].join('\n'));
  assert.equal(appendSectionLines(body, 'learned', ['- A']), body, 'duplicates compare case-insensitively');
  assert.equal(appendSectionLines('Lead.', 'Learned', ['- x']), ['Lead.', '', '## Learned', '- x'].join('\n'));
  assert.equal(appendSectionLines('Lead.', 'Learned', []), 'Lead.');
});

test('replaceSection swaps a section body, creating it when missing', () => {
  const body = ['Lead.', '', '## Learned', '- old', '', '## Chats', '- c'].join('\n');
  assert.equal(replaceSection(body, 'Learned', ['- new']), ['Lead.', '', '## Learned', '- new', '', '## Chats', '- c'].join('\n'));
  assert.equal(replaceSection('Lead.', 'Chats', ['- c']), ['Lead.', '', '## Chats', '- c'].join('\n'));
});

test('removeCallouts drops every callout block of one kind', () => {
  const body = ['![[a.png]]', 'ctx', '', '> [!pending]- Waiting', '> for the note-writer', '', '> [!more]- 1 more · uses', '> [[X]]'].join('\n');
  assert.equal(removeCallouts(body, 'pending'), ['![[a.png]]', 'ctx', '', '> [!more]- 1 more · uses', '> [[X]]'].join('\n'));
  assert.equal(removeCallouts('plain', 'pending'), 'plain');
});

test('insertSectionLines appends every line, repeats included, before the next section', () => {
  const body = ['## Transcript', '#### You', 'hi', '', '## Learned', '- a'].join('\n');
  assert.equal(insertSectionLines(body, 'Transcript', ['', '#### You', 'hi']), ['## Transcript', '#### You', 'hi', '', '#### You', 'hi', '', '## Learned', '- a'].join('\n'));
  assert.equal(insertSectionLines('Lead.', 'Transcript', ['#### You', 'hi']), ['Lead.', '', '## Transcript', '#### You', 'hi'].join('\n'));
});

test('sectionLines reads a section without its heading or trailing blanks, or null when missing', () => {
  const body = ['Lead.', '', '## Learned', '- a', '- b', '', '## Chats', '- c'].join('\n');
  assert.deepEqual(sectionLines(body, 'learned'), ['- a', '- b']);
  assert.deepEqual(sectionLines('## Learned', 'Learned'), []);
  assert.equal(sectionLines(body, 'Plans'), null);
});
