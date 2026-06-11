import * as fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const TARGETS = [
  'src/presets.ts',
  'src/status-server/http-utils.ts',
  'src/status-server/server-types.ts',
] as const;

const DICT_PATTERNS = [
  /import type \{ Dict \} from/u,
  /export type \{ Dict \}/u,
  /\btype\s+Dict\b/u,
  /:\s*Dict\b/u,
  /\bas\s+Dict\b/u,
  /\bDict\[\]/u,
  /\bRecord<string,\s*unknown>/u,
] as const;

const DUPLICATE_HELPERS = [
  /\bfunction\s+getPositiveNumber\b/u,
  /\bfunction\s+getOptionalNumber\b/u,
  /\bfunction\s+getTrimmedString\b/u,
  /\bfunction\s+getNonNegativeNumber\b/u,
  /\bfunction\s+getFiniteInteger\b/u,
  /\bfunction\s+getFiniteNumber\b/u,
  /\bfunction\s+isRecord\b/u,
] as const;

test('server boundary target files do not use Dict or Record<string, unknown>', () => {
  for (const target of TARGETS) {
    const source = fs.readFileSync(target, 'utf8');
    for (const pattern of DICT_PATTERNS) {
      assert.doesNotMatch(source, pattern, `${target} still matches ${pattern}`);
    }
  }
});

test('server boundary target files use shared JSON reader instead of local coercion helpers', () => {
  for (const target of TARGETS) {
    const source = fs.readFileSync(target, 'utf8');
    for (const pattern of DUPLICATE_HELPERS) {
      assert.doesNotMatch(source, pattern, `${target} still defines ${pattern}`);
    }
  }
});

test('contract catches Record<string, unknown> syntax at punctuation and whitespace boundaries', () => {
  const recordPattern = DICT_PATTERNS[6];
  assert.match('type X = Record<string, unknown>;', recordPattern);
  assert.match('let x: Record<string, unknown> = {};', recordPattern);
});
