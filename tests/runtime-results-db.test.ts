import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  closeRuntimeDatabase,
} from '../dist/state/runtime-db.js';
import {
  persistBenchmarkRun,
  persistEvalResult,
  readBenchmarkRun,
  readEvalResult,
} from '../dist/state/runtime-results.js';

function withTempRepo(fn: (repoRoot: string) => void): void {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-runtime-results-'));
  const previousCwd = process.cwd();
  try {
    fs.writeFileSync(
      path.join(repoRoot, 'package.json'),
      JSON.stringify({ name: 'siftkit', version: '0.1.0' }, null, 2),
      'utf8',
    );
    process.chdir(repoRoot);
    fn(repoRoot);
  } finally {
    process.chdir(previousCwd);
    closeRuntimeDatabase();
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
}

test('persistEvalResult stores payload in eval_results table', () => {
  withTempRepo(() => {
    const persisted = persistEvalResult({
      payload: {
        Backend: 'mock',
        Model: 'mock-model',
        Results: [{ Name: 'eval-fixture', Summary: 'ok' }],
      },
    });
    assert.match(persisted.uri, /^db:\/\/eval-results\//u);
    const row = readEvalResult(persisted.id);
    assert.ok(row);
    assert.equal(row?.payload.Backend, 'mock');
    assert.equal(Array.isArray(row?.payload.Results), true);
  });
});

test('persistBenchmarkRun stores payload in benchmark_runs table', () => {
  withTempRepo(() => {
    const persisted = persistBenchmarkRun({
      payload: {
        Status: 'completed',
        Backend: 'mock',
        Model: 'mock-model',
        Results: [{ Prompt: 'q', Output: 'a' }],
      },
    });
    assert.match(persisted.uri, /^db:\/\/benchmark-runs\//u);
    const row = readBenchmarkRun(persisted.id);
    assert.ok(row);
    assert.equal(row?.payload.Status, 'completed');
    assert.equal(Array.isArray(row?.payload.Results), true);
  });
});
