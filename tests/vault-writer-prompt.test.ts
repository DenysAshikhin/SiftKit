import test from 'node:test';
import assert from 'node:assert/strict';

import { writerInstructions } from '../src/vault/note-writer/agent/prompt.ts';

for (const source of ['capture', 'chat', 'review'] as const) {
  test(`the ${source} instructions keep transient state, status leads, oversized values and tool output out of notes`, () => {
    const instructions = writerInstructions(source);
    assert.match(instructions, /still be true next week/, 'durability rule');
    assert.match(instructions, /usage meters, quotas, timers/, 'transient screen state is named');
    assert.match(instructions, /no paths, counts, dates or current status/, 'a lead is not a status line');
    assert.match(instructions, /values under 200 characters and labels under 40/, 'the schema limits are stated');
    assert.match(instructions, /never paste tool output/, 'tool output is not a value');
  });
}
