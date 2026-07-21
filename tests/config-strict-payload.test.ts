import test from 'node:test';
import assert from 'node:assert/strict';

import { getDefaultConfigObject } from '../src/config/defaults.js';
import { JsonObjectSchema, type MutableJsonObject } from '../src/lib/json-types.js';
import { isStrictConfigPayload } from '../src/status-server/routes/core.js';

function defaultConfigPayload(): MutableJsonObject {
  return { ...JsonObjectSchema.parse(JSON.parse(JSON.stringify(getDefaultConfigObject()))) };
}

function sectionOf(payload: MutableJsonObject, key: string): MutableJsonObject {
  const section = JsonObjectSchema.parse(payload[key]);
  const copy: MutableJsonObject = { ...section };
  payload[key] = copy;
  return copy;
}

test('a complete config payload without top-level Backend is strict', () => {
  const payload = defaultConfigPayload();
  delete payload.Backend;
  assert.equal(isStrictConfigPayload(payload), true);
});

test('a genuinely partial payload is not strict', () => {
  assert.equal(isStrictConfigPayload({ PolicyMode: 'conservative' }), false);
});

test('a payload missing a required top-level section is not strict', () => {
  const payload = defaultConfigPayload();
  delete payload.Thresholds;
  assert.equal(isStrictConfigPayload(payload), false);
});

test('a payload missing a required nested field is not strict', () => {
  const payload = defaultConfigPayload();
  delete sectionOf(payload, 'Server').ModelPresets;
  assert.equal(isStrictConfigPayload(payload), false);
});

test('a non-object payload is not strict', () => {
  assert.equal(isStrictConfigPayload('nope'), false);
});
