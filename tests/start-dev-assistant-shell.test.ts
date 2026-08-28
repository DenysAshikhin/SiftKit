import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  AssistantShellConfigSchema,
  decideAssistantShellAction,
  getAssistantShellPath,
} from '../scripts/start-dev-assistant-shell.js';

test('assistant shell starts when the switch is already on at startup', () => {
  assert.equal(decideAssistantShellAction(null, true, false), 'start');
});

test('assistant shell stays stopped when the switch is off at startup', () => {
  assert.equal(decideAssistantShellAction(null, false, false), 'none');
});

test('assistant shell starts when the switch flips from off to on', () => {
  assert.equal(decideAssistantShellAction(false, true, false), 'start');
});

test('assistant shell stops when the switch flips from on to off', () => {
  assert.equal(decideAssistantShellAction(true, false, true), 'stop');
});

test('assistant shell is not restarted after a manual quit while the switch stays on', () => {
  assert.equal(decideAssistantShellAction(true, true, false), 'none');
});

test('assistant shell is left alone when nothing changed', () => {
  assert.equal(decideAssistantShellAction(true, true, true), 'none');
  assert.equal(decideAssistantShellAction(false, false, false), 'none');
});

test('assistant shell stop is a no-op when it is not running', () => {
  assert.equal(decideAssistantShellAction(true, false, false), 'none');
});

test('assistant shell path points at the release desktop build', () => {
  assert.equal(
    getAssistantShellPath('C:\u005csome\u005crepo'),
    path.join('C:\u005csome\u005crepo', 'desktop', 'src-tauri', 'target', 'release', 'siftkit-assistant-shell.exe'),
  );
});

test('assistant shell config schema extracts only the enabled flag', () => {
  const parsed = AssistantShellConfigSchema.parse({
    Assistant: { Enabled: true, Owner: { Id: 'own_local' } },
    Runtime: {},
  });

  assert.deepEqual(parsed, { Assistant: { Enabled: true } });
});

test('start-dev wires the assistant shell watcher into the dev stack', () => {
  const script = fs.readFileSync(path.join('scripts', 'start-dev.ts'), 'utf8');

  assert.match(script, /start-dev-assistant-shell\.js/u);
  assert.match(script, /decideAssistantShellAction/u);
  assert.match(script, /\/config/u);
});
