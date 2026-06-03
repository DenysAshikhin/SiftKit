import test from 'node:test';
import assert from 'node:assert/strict';
import { commandMatchesDisplayText, getDisplayToolCommand } from '../src/status-server/tool-command-display';

test('getDisplayToolCommand prefers modelVisibleCommand and falls back to command', () => {
  assert.equal(getDisplayToolCommand({ modelVisibleCommand: ' rg foo ', command: 'rg bar' }), 'rg foo');
  assert.equal(getDisplayToolCommand({ command: ' rg bar ' }), 'rg bar');
  assert.equal(getDisplayToolCommand({}), '');
});

test('commandMatchesDisplayText matches either modelVisibleCommand or command', () => {
  assert.equal(commandMatchesDisplayText({ modelVisibleCommand: 'rg foo', command: 'rg bar' }, 'rg foo'), true);
  assert.equal(commandMatchesDisplayText({ modelVisibleCommand: 'rg foo', command: 'rg bar' }, 'rg bar'), true);
  assert.equal(commandMatchesDisplayText({ modelVisibleCommand: 'rg foo', command: 'rg bar' }, 'rg baz'), false);
});

test('commandMatchesDisplayText returns false for empty target so malformed records do not collide with empty delete input', () => {
  assert.equal(commandMatchesDisplayText({}, ''), false);
  assert.equal(commandMatchesDisplayText({ modelVisibleCommand: '', command: '' }, ''), false);
  assert.equal(commandMatchesDisplayText({ command: 'rg foo' }, '   '), false);
});
