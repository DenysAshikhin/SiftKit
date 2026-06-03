import test from 'node:test';
import assert from 'node:assert/strict';
import { getDisplayToolCommand, commandMatchesDisplayText } from '../src/lib/display-command';

test('getDisplayToolCommand prefers modelVisibleCommand', () => {
  assert.equal(getDisplayToolCommand({ modelVisibleCommand: ' rg foo ', command: 'rg bar' }), 'rg foo');
  assert.equal(getDisplayToolCommand({ command: ' rg bar ' }), 'rg bar');
  assert.equal(getDisplayToolCommand({}), '');
});

test('commandMatchesDisplayText accepts either field', () => {
  assert.equal(commandMatchesDisplayText({ modelVisibleCommand: 'rg foo' }, 'rg foo'), true);
  assert.equal(commandMatchesDisplayText({ command: 'rg bar' }, 'rg bar'), true);
  assert.equal(commandMatchesDisplayText({}, 'anything'), false);
});

test('commandMatchesDisplayText returns false for empty target', () => {
  assert.equal(commandMatchesDisplayText({}, ''), false);
  assert.equal(commandMatchesDisplayText({ command: 'rg foo' }, '   '), false);
});
