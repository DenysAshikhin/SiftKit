import test from 'node:test';
import assert from 'node:assert/strict';

import { addRowValues, buildEntityBody, replaceLead, rewriteLinks } from '@siftkit/contracts';

const values = (count: number, prefix: string) => Array.from({ length: count }, (_, i) => `[[${prefix}${i + 1}]]`);

test('buildEntityBody writes lead, capped rows, tasks, overflow and unverified sections', () => {
  const body = buildEntityBody({
    lead: 'SiftKit is a project you work on.',
    rows: [{ label: 'Uses', values: values(10, 'T') }, { label: 'Runs on', values: ['[[Windows]]', '[[windows]]'] }, { label: 'Empty', values: [] }],
    taskSections: [{ heading: 'Plans', items: ['Ship the vault'] }],
    unverified: [{ label: 'Uses', value: '[[GitHub]]' }],
  });
  assert.equal(body, [
    'SiftKit is a project you work on.',
    '',
    `**Uses** ${values(8, 'T').join(' · ')}`,
    '**Runs on** [[Windows]]',
    '',
    '## Plans',
    '- [ ] Ship the vault',
    '',
    '> [!more]- 2 more · uses',
    '> [[T9]] · [[T10]]',
    '',
    '> [!unverified]- 1 unverified fact',
    '> - **Uses** [[GitHub]] #unverified',
  ].join('\n'));
});

test('addRowValues appends to an existing row and skips duplicates case-insensitively', () => {
  const body = 'Lead.\n\n**Uses** [[Git]]';
  assert.equal(addRowValues(body, 'uses', ['[[git]]', '[[npm]]']), 'Lead.\n\n**Uses** [[Git]] · [[npm]]');
  assert.equal(addRowValues(body, 'Uses', ['[[GIT]]']), body);
});

test('addRowValues inserts a new row after the last row, or after the lead', () => {
  assert.equal(addRowValues('Lead.\n\n**Uses** [[Git]]\n\n## Plans\n- [ ] x', 'Runs on', ['[[Windows]]']),
    'Lead.\n\n**Uses** [[Git]]\n**Runs on** [[Windows]]\n\n## Plans\n- [ ] x');
  assert.equal(addRowValues('Lead.', 'Uses', ['[[Git]]']), 'Lead.\n\n**Uses** [[Git]]');
  assert.equal(addRowValues('', 'Uses', ['[[Git]]']), '**Uses** [[Git]]');
});

test('addRowValues moves overflow into the matching more callout, before unverified facts', () => {
  const full = `Lead.\n\n**Uses** ${values(8, 'T').join(' · ')}\n\n> [!unverified]- 1 unverified fact\n> - x #unverified`;
  const once = addRowValues(full, 'Uses', ['[[New1]]']);
  assert.equal(once, `Lead.\n\n**Uses** ${values(8, 'T').join(' · ')}\n\n> [!more]- 1 more · uses\n> [[New1]]\n\n> [!unverified]- 1 unverified fact\n> - x #unverified`);
  const twice = addRowValues(once, 'Uses', ['[[New2]]', '[[new1]]', '[[T3]]']);
  assert.match(twice, /> \[!more\]- 2 more · uses\n> \[\[New1\]\] · \[\[New2\]\]/);
});

test('replaceLead swaps the first paragraph or prepends one', () => {
  assert.equal(replaceLead('Old lead.\n\n**Uses** [[A]]', 'New lead.'), 'New lead.\n\n**Uses** [[A]]');
  assert.equal(replaceLead('**Uses** [[A]]', 'New lead.'), 'New lead.\n\n**Uses** [[A]]');
});

test('rewriteLinks renames link targets but keeps headings, display text and embeds', () => {
  const result = rewriteLinks('[[Old Name]] · [[old name|alias]] · [[Old Name#Plans]] · ![[Old Name]] · [[Old Names]]', 'Old Name', 'New');
  assert.deepEqual(result, { body: '[[New]] · [[New|alias]] · [[New#Plans]] · ![[Old Name]] · [[Old Names]]', count: 3 });
});
