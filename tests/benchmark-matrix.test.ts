import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  readMatrixManifest,
  buildLaunchSignature,
  buildLauncherArgs,
  buildBenchmarkArgs,
  pruneOldLauncherLogs,
} from '../dist/benchmark-matrix/index.js';

type MatrixTarget = Parameters<typeof buildLaunchSignature>[0];
type MatrixManifest = Parameters<typeof buildLauncherArgs>[0];
type MatrixRun = Parameters<typeof buildBenchmarkArgs>[1];

test('buildLaunchSignature produces pipe-separated string', () => {
  const target = {
    startScript: 'C:\\scripts\\start.ps1',
    resolvedModelPath: 'C:\\models\\model.gguf',
    contextSize: 128000,
    maxTokens: 4096,
    passReasoningArg: true,
    reasoning: 'off',
    modelPath: 'C:\\models\\model.gguf',
  } as unknown as MatrixTarget;
  const sig = buildLaunchSignature(target);
  assert.match(sig, /start\.ps1/u);
  assert.match(sig, /model\.gguf/u);
  assert.match(sig, /128000/u);
  assert.match(sig, /4096/u);
  assert.match(sig, /off/u);
  assert.ok(sig.split('|').length === 5);
});

test('buildLaunchSignature uses script-controlled when passReasoningArg is false', () => {
  const target = {
    startScript: 'C:\\scripts\\start.ps1',
    resolvedModelPath: 'C:\\models\\model.gguf',
    contextSize: 64000,
    maxTokens: 2048,
    passReasoningArg: false,
    reasoning: 'on',
    modelPath: 'C:\\models\\model.gguf',
  } as unknown as MatrixTarget;
  const sig = buildLaunchSignature(target);
  assert.match(sig, /script-controlled/u);
  assert.doesNotMatch(sig, /\bon\b/u);
});

test('buildLauncherArgs produces correct PowerShell arguments', () => {
  const manifest = {
    configUrl: 'http://localhost:4765/config',
    fixtureRoot: 'C:\\fixtures',
    requestTimeoutSeconds: 120,
  } as unknown as MatrixManifest;
  const target = {
    startScript: 'C:\\scripts\\start.ps1',
    modelPath: 'C:\\models\\model.gguf',
    contextSize: 128000,
    maxTokens: 4096,
    passReasoningArg: false,
    reasoning: 'off',
  } as unknown as Parameters<typeof buildLauncherArgs>[1];
  const args = buildLauncherArgs(manifest, target);
  assert.ok(Array.isArray(args));
  assert.ok(args.includes('-NoProfile'));
  assert.ok(args.includes('-File'));
  assert.ok(args.includes('C:\\scripts\\start.ps1'));
  assert.ok(args.includes('-ConfigUrl'));
  assert.ok(args.includes('-ContextSize'));
  assert.ok(args.includes('128000'));
});

test('buildLauncherArgs includes reasoning arg when passReasoningArg is true', () => {
  const manifest = { configUrl: 'http://localhost:4765/config' } as unknown as MatrixManifest;
  const target = {
    startScript: 'C:\\scripts\\start.ps1',
    modelPath: 'C:\\models\\model.gguf',
    contextSize: 128000,
    maxTokens: 4096,
    passReasoningArg: true,
    reasoning: 'auto',
  } as unknown as Parameters<typeof buildLauncherArgs>[1];
  const args = buildLauncherArgs(manifest, target);
  assert.ok(args.includes('-Reasoning'));
  assert.ok(args.includes('auto'));
});

test('buildBenchmarkArgs produces correct node arguments', () => {
  const manifest = {
    configUrl: 'http://localhost:4765/config',
    fixtureRoot: 'C:\\fixtures',
    requestTimeoutSeconds: 120,
  } as unknown as MatrixManifest;
  const run = {
    modelId: 'test-model',
    maxTokens: 4096,
  } as unknown as MatrixRun;
  const args = buildBenchmarkArgs(manifest, run, 'C:\\output\\result.json', null);
  assert.ok(Array.isArray(args));
  assert.ok(args.includes('--fixture-root'));
  assert.ok(args.includes('--model'));
  assert.ok(args.includes('test-model'));
  assert.ok(args.includes('--max-tokens'));
  assert.equal(args.includes('--temperature'), false);
  assert.equal(args.includes('--top-p'), false);
  assert.equal(args.includes('--top-k'), false);
  assert.equal(args.includes('--min-p'), false);
  assert.equal(args.includes('--presence-penalty'), false);
  assert.equal(args.includes('--repetition-penalty'), false);
});

test('buildBenchmarkArgs includes prompt-prefix-file when provided', () => {
  const manifest = {
    fixtureRoot: 'C:\\fixtures',
    requestTimeoutSeconds: 120,
  } as unknown as MatrixManifest;
  const run = {
    modelId: 'test-model',
    maxTokens: 4096,
  } as unknown as MatrixRun;
  const args = buildBenchmarkArgs(manifest, run, 'C:\\output\\result.json', 'C:\\prefix.txt');
  assert.ok(args.includes('--prompt-prefix-file'));
  assert.ok(args.includes('C:\\prefix.txt'));
});

test('pruneOldLauncherLogs deletes old launcher logs', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-prune-'));
  try {
    const newLog = path.join(tempRoot, 'launcher_1_run1_stdout.log');
    fs.writeFileSync(newLog, 'new log', 'utf8');
    const oldLog = path.join(tempRoot, 'launcher_2_run2_stderr.log');
    fs.writeFileSync(oldLog, 'old log', 'utf8');
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    fs.utimesSync(oldLog, tenDaysAgo, tenDaysAgo);

    const deleted = pruneOldLauncherLogs(tempRoot);
    assert.ok(deleted >= 1);
    assert.ok(fs.existsSync(newLog));
    assert.ok(!fs.existsSync(oldLog));
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('pruneOldLauncherLogs returns 0 for empty directory', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-prune-empty-'));
  try {
    const deleted = pruneOldLauncherLogs(tempRoot);
    assert.equal(deleted, 0);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('readMatrixManifest reads and resolves a manifest', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-manifest-'));
  try {
    const fixtureRoot = path.join(tempRoot, 'fixtures');
    const resultsRoot = path.join(tempRoot, 'results');
    const startScript = path.join(tempRoot, 'start.ps1');
    fs.mkdirSync(fixtureRoot, { recursive: true });
    fs.mkdirSync(resultsRoot, { recursive: true });
    fs.writeFileSync(startScript, '# dummy start script', 'utf8');
    fs.writeFileSync(path.join(tempRoot, 'baseline.gguf'), 'dummy', 'utf8');
    fs.writeFileSync(path.join(tempRoot, 'test.gguf'), 'dummy', 'utf8');
    fs.writeFileSync(path.join(fixtureRoot, 'fixtures.json'), JSON.stringify([
      { Name: 'test', File: 'source.txt', Question: 'test', Format: 'text', PolicyProfile: 'general' },
    ]), 'utf8');
    fs.writeFileSync(path.join(fixtureRoot, 'source.txt'), 'test data', 'utf8');

    const manifestPath = path.join(tempRoot, 'matrix.json');
    fs.writeFileSync(manifestPath, JSON.stringify({
      fixtureRoot,
      configUrl: 'http://localhost:4765/config',
      startScript,
      resultsRoot,
      baseline: {
        modelId: 'baseline-model',
        modelPath: path.join(tempRoot, 'baseline.gguf'),
        contextSize: 128000,
        maxTokens: 4096,
        reasoning: 'off',
      },
      runs: [
        {
          index: 1,
          id: 'run-1',
          label: 'Test Run 1',
          enabled: true,
          modelId: 'test-model',
          modelPath: path.join(tempRoot, 'test.gguf'),
        },
      ],
    }), 'utf8');

    const manifest = readMatrixManifest({
      manifestPath,
      runIds: [],
      promptPrefixFile: null,
      requestTimeoutSeconds: null,
      validateOnly: false,
    });
    assert.equal(typeof manifest.configUrl, 'string');
    assert.ok(Array.isArray(manifest.selectedRuns));
    assert.ok(manifest.selectedRuns.length >= 1);
    assert.equal(manifest.selectedRuns[0].id, 'run-1');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
