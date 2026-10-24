import test from 'node:test';
import assert from 'node:assert/strict';

import { addTasks, addUnverified, confirmUnverified, dropLine, mergeEntityDraft } from '@siftkit/contracts';

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
