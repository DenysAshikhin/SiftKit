import test from 'node:test';
import assert from 'node:assert/strict';

import {
  addTasks, addUnverified, appendSectionLines, confirmUnverified, dropLine, insertSectionLines, mergeEntityDraft, removeCallouts, replaceSection, sectionLines,
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

test('confirmUnverified moves the fact into its row and decrements the header', () => {
  assert.equal(confirmUnverified(BODY, 8), [
    'Lead.', '', '**Uses** [[Git]] · [[GitHub]]', '', '## Plans', '- [ ] Ship it', '',
    '> [!unverified]- 1 unverified fact', '> - **Prefers** Dark mode #unverified',
  ].join('\n'));
});

test('confirming the last unverified fact removes the callout and creates a new row', () => {
  const once = confirmUnverified(BODY, 8);
  assert.equal(confirmUnverified(once, 8), 'Lead.\n\n**Uses** [[Git]] · [[GitHub]]\n**Prefers** Dark mode\n\n## Plans\n- [ ] Ship it');
});

test('confirmUnverified rejects a line that is not an unverified fact', () => {
  assert.throws(() => confirmUnverified(BODY, 2), /Line 2 is not an unverified fact/);
});

test('dropLine removes unverified facts with header bookkeeping, and plain lines as-is', () => {
  assert.match(dropLine(BODY, 9), /> \[!unverified\]- 1 unverified fact\n> - \*\*Uses\*\* \[\[GitHub\]\] #unverified$/);
  assert.equal(dropLine('a\nb\nc', 1), 'a\nc');
  assert.throws(() => dropLine('a', 4), /Line 4 is outside the note/);
});

test('addTasks appends under an existing heading or creates the section before callouts', () => {
  assert.match(addTasks(BODY, 'Plans', ['Ship it', 'Write docs']), /## Plans\n- \[ \] Ship it\n- \[ \] Write docs\n\n> \[!unverified\]/);
  assert.match(addTasks(BODY, 'Goals', ['Learn Rust']), /- \[ \] Ship it\n\n## Goals\n- \[ \] Learn Rust\n\n> \[!unverified\]/);
});

test('addUnverified skips facts already present as rows or unverified lines', () => {
  const next = addUnverified(BODY, [{ label: 'Uses', value: '[[Git]]' }, { label: 'Uses', value: '[[github]]' }, { label: 'Owns', value: '[[PC]]' }]);
  assert.match(next, /> \[!unverified\]- 3 unverified facts\n> - \*\*Uses\*\* \[\[GitHub\]\] #unverified\n> - \*\*Prefers\*\* Dark mode #unverified\n> - \*\*Owns\*\* \[\[PC\]\] #unverified$/);
  assert.equal(addUnverified('Lead.', [{ label: 'Uses', value: 'x' }]), 'Lead.\n\n> [!unverified]- 1 unverified fact\n> - **Uses** x #unverified');
});

test('mergeEntityDraft keeps an existing lead and unions rows, tasks and unverified facts', () => {
  const merged = mergeEntityDraft(BODY, {
    lead: 'Other lead.',
    rows: [{ label: 'Uses', values: ['[[Git]]', '[[npm]]'] }],
    taskSections: [{ heading: 'Plans', items: ['Ship it', 'Celebrate'] }],
    unverified: [{ label: 'Owns', value: '[[PC]]' }],
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
