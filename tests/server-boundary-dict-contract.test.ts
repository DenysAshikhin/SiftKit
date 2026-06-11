import * as fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const TARGETS = [
  'src/presets.ts',
  'src/state/chat-sessions.ts',
  'src/state/dashboard-benchmark.ts',
  'src/state/jsonl-transcript.ts',
  'src/state/runtime-artifacts.ts',
  'src/state/runtime-results.ts',
  'src/thinking-retention-policy.ts',
  'src/status-server/chat.ts',
  'src/status-server/dashboard-benchmark-runner.ts',
  'src/status-server/dashboard-runs.ts',
  'src/status-server/http-utils.ts',
  'src/status-server/idle-summary.ts',
  'src/status-server/managed-llama.ts',
  'src/status-server/metrics.ts',
  'src/status-server/preset-runner.ts',
  'src/status-server/repo-search-request-normalizers.ts',
  'src/status-server/routes/chat.ts',
  'src/status-server/routes/core.ts',
  'src/status-server/routes/dashboard.ts',
  'src/status-server/routes/llama-passthrough.ts',
  'src/status-server/server-types.ts',
  'src/status-server/status-file.ts',
  'src/status-server/tool-command-display.ts',
] as const;

const DICT_PATTERNS = [
  /import type \{ Dict \} from/u,
  /export type \{ Dict \}/u,
  /\btype\s+Dict\b/u,
  /:\s*Dict\b/u,
  /\bas\s+Dict\b/u,
  /\bDict\[\]/u,
  /\bRecord<string,\s*unknown>/u,
  /\bJsonRecord\b/u,
  /\[\s*key\s*:\s*string\s*\]\s*:\s*unknown/u,
] as const;

const DUPLICATE_HELPERS = [
  /\bfunction\s+getPositiveNumber\b/u,
  /\bfunction\s+getOptionalNumber\b/u,
  /\bfunction\s+getTrimmedString\b/u,
  /\bfunction\s+getOptionalString\b/u,
  /\bfunction\s+getNonNegativeNumber\b/u,
  /\bfunction\s+toNonNegativeInteger\b/u,
  /\bfunction\s+toNullableNonNegativeInteger\b/u,
  /\bfunction\s+toNullableNonNegativeNumber\b/u,
  /\bfunction\s+getFiniteInteger\b/u,
  /\bfunction\s+getFiniteNumber\b/u,
  /\bfunction\s+isRecord\b/u,
] as const;

test('server boundary target files do not use untyped map aliases', () => {
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

test('contract catches untyped map syntax at punctuation and whitespace boundaries', () => {
  const recordPattern = DICT_PATTERNS[6];
  assert.match('type X = Record<string, unknown>;', recordPattern);
  assert.match('let x: Record<string, unknown> = {};', recordPattern);
  assert.match('type X = JsonRecord;', DICT_PATTERNS[7]);
  assert.match('type X = { [key: string]: unknown };', DICT_PATTERNS[8]);
});
