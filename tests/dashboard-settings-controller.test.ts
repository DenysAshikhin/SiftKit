import test from 'node:test';
import assert from 'node:assert/strict';
import { createUniquePresetId } from '../dashboard/src/hooks/useSettingsController.js';

test('disambiguates a colliding slug', () => {
  const existing = [{ id: 'my-preset' }];
  const id = createUniquePresetId(existing, 'My Preset');
  assert.notEqual(id, 'my-preset');
  assert.match(id, /my-preset/u);
});
