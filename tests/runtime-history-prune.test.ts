import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getRuntimeHistoryRetentionDays } from '../src/state/runtime-retention.js';

// ---------------------------------------------------------------------------
// Shared retention configuration tests
// ---------------------------------------------------------------------------

test('getRuntimeHistoryRetentionDays returns default of 7', () => {
  const prev = process.env.SIFTKIT_RUNTIME_HISTORY_RETENTION_DAYS;
  delete process.env.SIFTKIT_RUNTIME_HISTORY_RETENTION_DAYS;
  try {
    assert.equal(getRuntimeHistoryRetentionDays(), 7);
  } finally {
    if (prev !== undefined) {
      process.env.SIFTKIT_RUNTIME_HISTORY_RETENTION_DAYS = prev;
    }
  }
});

test('getRuntimeHistoryRetentionDays respects env override', () => {
  const prev = process.env.SIFTKIT_RUNTIME_HISTORY_RETENTION_DAYS;
  process.env.SIFTKIT_RUNTIME_HISTORY_RETENTION_DAYS = '14';
  try {
    assert.equal(getRuntimeHistoryRetentionDays(), 14);
  } finally {
    if (prev !== undefined) {
      process.env.SIFTKIT_RUNTIME_HISTORY_RETENTION_DAYS = prev;
    } else {
      delete process.env.SIFTKIT_RUNTIME_HISTORY_RETENTION_DAYS;
    }
  }
});

test('getRuntimeHistoryRetentionDays ignores zero', () => {
  const prev = process.env.SIFTKIT_RUNTIME_HISTORY_RETENTION_DAYS;
  process.env.SIFTKIT_RUNTIME_HISTORY_RETENTION_DAYS = '0';
  try {
    assert.equal(getRuntimeHistoryRetentionDays(), 7);
  } finally {
    if (prev !== undefined) {
      process.env.SIFTKIT_RUNTIME_HISTORY_RETENTION_DAYS = prev;
    } else {
      delete process.env.SIFTKIT_RUNTIME_HISTORY_RETENTION_DAYS;
    }
  }
});

test('getRuntimeHistoryRetentionDays ignores negative', () => {
  const prev = process.env.SIFTKIT_RUNTIME_HISTORY_RETENTION_DAYS;
  process.env.SIFTKIT_RUNTIME_HISTORY_RETENTION_DAYS = '-5';
  try {
    assert.equal(getRuntimeHistoryRetentionDays(), 7);
  } finally {
    if (prev !== undefined) {
      process.env.SIFTKIT_RUNTIME_HISTORY_RETENTION_DAYS = prev;
    } else {
      delete process.env.SIFTKIT_RUNTIME_HISTORY_RETENTION_DAYS;
    }
  }
});

test('getRuntimeHistoryRetentionDays ignores non-numeric', () => {
  const prev = process.env.SIFTKIT_RUNTIME_HISTORY_RETENTION_DAYS;
  process.env.SIFTKIT_RUNTIME_HISTORY_RETENTION_DAYS = 'abc';
  try {
    assert.equal(getRuntimeHistoryRetentionDays(), 7);
  } finally {
    if (prev !== undefined) {
      process.env.SIFTKIT_RUNTIME_HISTORY_RETENTION_DAYS = prev;
    } else {
      delete process.env.SIFTKIT_RUNTIME_HISTORY_RETENTION_DAYS;
    }
  }
});

test('DEFAULT_RUNTIME_HISTORY_RETENTION_DAYS is exported as 7', async () => {
  const mod = await import('../src/state/runtime-retention.js');
  assert.equal(mod.DEFAULT_RUNTIME_HISTORY_RETENTION_DAYS, 7);
});

test('status server prunes repo-agent runs with runtime history retention', () => {
  const source = readFileSync(
    join(process.cwd(), 'src', 'status-server', 'index.ts'),
    'utf8',
  );
  assert.match(source, /new RepoAgentRunStore\(/u);
  assert.match(
    source,
    /repoAgentRunStore\.pruneTerminalRuns\(retentionDays, new Date\(\)\)/u,
  );
});
