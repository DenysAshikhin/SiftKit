import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  ActivityEventDtoSchema,
  CaptureSubmissionDtoSchema,
  DesktopStateDtoSchema,
  EnvironmentStateDtoSchema,
  KeyCustodyStatusDtoSchema,
  KeyMaterialDtoSchema,
  SuppressionAuditDtoSchema,
} from '@siftkit/contracts';
import { parseJsonValueText } from '../src/lib/json.js';
import type { JsonValue } from '../src/lib/json-types.js';
import type { ZodType } from 'zod';

const FIXTURE_ROOT = path.join(process.cwd(), 'desktop', 'contract-fixtures');

function readFixture(name: string): JsonValue {
  return parseJsonValueText(fs.readFileSync(path.join(FIXTURE_ROOT, name), 'utf8'));
}

const FIXTURES: ReadonlyArray<readonly [string, ZodType]> = [
  ['activity-event.json', ActivityEventDtoSchema],
  ['environment-state.json', EnvironmentStateDtoSchema],
  ['capture-submission.json', CaptureSubmissionDtoSchema],
  ['suppression-audit.json', SuppressionAuditDtoSchema],
  ['key-custody-status.json', KeyCustodyStatusDtoSchema],
  ['key-material.json', KeyMaterialDtoSchema],
  ['desktop-state.json', DesktopStateDtoSchema],
];

test('every golden fixture parses with its own schema', () => {
  for (const [name, schema] of FIXTURES) {
    const parsed = schema.parse(readFixture(name));
    assert.deepEqual(parsed, readFixture(name), `${name} must round-trip unchanged`);
  }
});

test('an unknown schemaVersion fails closed for every desktop DTO', () => {
  const unknown = readFixture('unknown-version.json');
  for (const [name, schema] of FIXTURES) {
    assert.equal(schema.safeParse(unknown).success, false, `${name} schema must reject version 2`);
  }
});

test('desktop DTOs reject unknown properties', () => {
  for (const [name, schema] of FIXTURES) {
    const fixture = readFixture(name);
    assert.ok(fixture !== null && typeof fixture === 'object');
    assert.equal(
      schema.safeParse({ ...fixture, unexpectedField: true }).success,
      false,
      `${name} schema must be strict`,
    );
  }
});

test('activity event fixture carries the gate D foreground shape', () => {
  const activity = ActivityEventDtoSchema.parse(readFixture('activity-event.json'));
  assert.equal(activity.schemaVersion, 1);
  assert.equal(activity.foreground.processName, 'Code.exe');
  assert.equal(activity.sessionLocked, false);
});

test('capture submission rejects an oversized data URL and malformed hashes', () => {
  const fixture = CaptureSubmissionDtoSchema.parse(readFixture('capture-submission.json'));
  const oversized = `data:image/png;base64,${'A'.repeat(28 * 1024 * 1024)}`;
  assert.equal(CaptureSubmissionDtoSchema.safeParse({ ...fixture, imageDataUrl: oversized }).success, false);
  assert.equal(CaptureSubmissionDtoSchema.safeParse({ ...fixture, pixelSha256: 'abc' }).success, false);
  assert.equal(CaptureSubmissionDtoSchema.safeParse({ ...fixture, perceptualHash: 'abc' }).success, false);
  assert.equal(CaptureSubmissionDtoSchema.safeParse({ ...fixture, reason: 'idle' }).success, false);
});

test('environment state power is a closed discriminated union', () => {
  const fixture = EnvironmentStateDtoSchema.parse(readFixture('environment-state.json'));
  assert.equal(fixture.power.kind, 'available');
  const unavailable = EnvironmentStateDtoSchema.parse({ ...fixture, power: { kind: 'unavailable' } });
  assert.equal(unavailable.power.kind, 'unavailable');
  assert.equal(EnvironmentStateDtoSchema.safeParse({ ...fixture, power: { kind: 'guessing' } }).success, false);
  assert.equal(
    EnvironmentStateDtoSchema.safeParse({ ...fixture, power: { kind: 'unavailable', onBattery: true } }).success,
    false,
  );
});

test('suppression rule ids are a closed set', () => {
  const fixture = SuppressionAuditDtoSchema.parse(readFixture('suppression-audit.json'));
  assert.equal(fixture.ruleId, 'private_mode');
  assert.equal(SuppressionAuditDtoSchema.safeParse({ ...fixture, ruleId: 'because_i_said_so' }).success, false);
});

test('key material requires non-empty ids and values', () => {
  const fixture = KeyMaterialDtoSchema.parse(readFixture('key-material.json'));
  assert.equal(fixture.activeKeyId, 'akey_001');
  assert.equal(KeyMaterialDtoSchema.safeParse({ ...fixture, activeKeyId: '' }).success, false);
  assert.equal(KeyMaterialDtoSchema.safeParse({ ...fixture, keys: { akey_001: '' } }).success, false);
});

test('desktop DTOs carry mouse and keyboard idleness separately and reject the old combined field', () => {
  const environment = readFixture('environment-state.json');
  const activity = readFixture('activity-event.json');
  assert.ok(environment !== null && typeof environment === 'object' && !Array.isArray(environment));
  assert.ok(activity !== null && typeof activity === 'object' && !Array.isArray(activity));

  const { secondsSinceMouseInput, secondsSinceKeyboardInput, ...environmentRest } = environment;
  assert.equal(secondsSinceMouseInput, 4);
  assert.equal(secondsSinceKeyboardInput, 9);
  assert.equal(EnvironmentStateDtoSchema.safeParse(environmentRest).success, false);
  assert.equal(
    EnvironmentStateDtoSchema.safeParse({ ...environmentRest, secondsSinceInput: 4 }).success,
    false,
  );

  const { mouseIdleSeconds, keyboardIdleSeconds, ...activityRest } = activity;
  assert.equal(mouseIdleSeconds, 4);
  assert.equal(keyboardIdleSeconds, 9);
  assert.equal(ActivityEventDtoSchema.safeParse(activityRest).success, false);
  assert.equal(ActivityEventDtoSchema.safeParse({ ...activityRest, idleSeconds: 4 }).success, false);
});
