import test from 'node:test';
import assert from 'node:assert/strict';

import { CommandOutputAnalyzer } from '../src/command-output/analyzer.js';
import { withTestEnvAndServer } from './_test-helpers.js';

function createAnalyzer(): CommandOutputAnalyzer {
  return new CommandOutputAnalyzer();
}

test('analyzeCommandOutput with NoSummarize returns no-summarize result', async () => {
  await withTestEnvAndServer(async () => {
    const result = await createAnalyzer().analyze({
      repoRoot: process.cwd(),
      outputKind: 'command',
      exitCode: 0,
      combinedText: 'Build completed successfully.\nAll 42 tests passed.',
      question: 'Did the build pass?',
      noSummarize: true,
    });
    assert.equal(result.WasSummarized, false);
    assert.equal(result.PolicyDecision, 'no-summarize');
    assert.equal(result.Classification, 'no-summarize');
    assert.equal(result.ModelCallSucceeded, false);
    assert.equal(typeof result.RawLogPath, 'string');
  });
});

test('analyzeCommandOutput with short input returns a result with a policy decision', async () => {
  await withTestEnvAndServer(async () => {
    const result = await createAnalyzer().analyze({
      repoRoot: process.cwd(),
      outputKind: 'command',
      exitCode: 0,
      combinedText: 'ok',
      question: 'Did it work?',
    });
    assert.equal(typeof result.PolicyDecision, 'string');
    assert.equal(typeof result.RawLogPath, 'string');
    assert.equal(result.ExitCode, 0);
  });
});

test('analyzeCommandOutput with large input summarizes via model', async () => {
  await withTestEnvAndServer(async () => {
    const longOutput = 'Line of output from build\n'.repeat(100);
    const result = await createAnalyzer().analyze({
      repoRoot: process.cwd(),
      outputKind: 'command',
      exitCode: 0,
      combinedText: longOutput,
      question: 'Summarize the build output',
    });
    assert.equal(result.WasSummarized, true);
    assert.equal(result.Classification, 'summary');
    assert.equal(typeof result.Summary, 'string');
    assert.ok((result.Summary || '').length > 0);
  });
});

test('analyzeCommandOutput with risky risk level summarizes command output', async () => {
  await withTestEnvAndServer(async () => {
    const longOutput = 'Deleting row from production database\n'.repeat(100);
    const result = await createAnalyzer().analyze({
      repoRoot: process.cwd(),
      outputKind: 'command',
      exitCode: 0,
      combinedText: longOutput,
      question: 'What happened?',
      riskLevel: 'risky',
    });
    assert.equal(result.WasSummarized, true);
  });
});

test('analyzeCommandOutput reducer "none" preserves full text', async () => {
  await withTestEnvAndServer(async () => {
    const lines = Array.from({ length: 250 }, (_, i) => `line ${i}`).join('\n');
    const result = await createAnalyzer().analyze({
      repoRoot: process.cwd(),
      outputKind: 'command',
      exitCode: 0,
      combinedText: lines,
      question: 'Summarize',
      reducerProfile: 'none',
    });
    assert.equal(result.WasSummarized, true);
    assert.equal(result.ReducedLogPath, null);
  });
});

test('analyzeCommandOutput reducer "tail" creates reduced log', async () => {
  await withTestEnvAndServer(async () => {
    const lines = Array.from({ length: 250 }, (_, i) => `line ${i}`).join('\n');
    const result = await createAnalyzer().analyze({
      repoRoot: process.cwd(),
      outputKind: 'command',
      exitCode: 0,
      combinedText: lines,
      question: 'Summarize',
      reducerProfile: 'tail',
    });
    assert.equal(result.WasSummarized, true);
    assert.equal(typeof result.ReducedLogPath, 'string');
  });
});

test('analyzeCommandOutput reducer "errors" extracts error context', async () => {
  await withTestEnvAndServer(async () => {
    const lines = [
      ...Array.from({ length: 120 }, (_, i) => `info line ${i}`),
      'ERROR: something went wrong',
      'at Module._compile (node:internal/modules/cjs/loader:1356:14)',
      ...Array.from({ length: 120 }, (_, i) => `info line ${120 + i}`),
    ].join('\n');
    const result = await createAnalyzer().analyze({
      repoRoot: process.cwd(),
      outputKind: 'command',
      exitCode: 1,
      combinedText: lines,
      question: 'What failed?',
      reducerProfile: 'errors',
    });
    assert.equal(result.WasSummarized, true);
    assert.equal(typeof result.ReducedLogPath, 'string');
  });
});

test('analyzeCommandOutput reducer "diff" filters diff lines', async () => {
  await withTestEnvAndServer(async () => {
    const lines = [
      'diff --git a/file.js b/file.js',
      'index abc..def 100644',
      '--- a/file.js',
      '+++ b/file.js',
      '@@ -1,3 +1,4 @@',
      ' const a = 1;',
      '+const b = 2;',
      ' const c = 3;',
      ...Array.from({ length: 250 }, (_, i) => `unchanged line ${i}`),
    ].join('\n');
    const result = await createAnalyzer().analyze({
      repoRoot: process.cwd(),
      outputKind: 'command',
      exitCode: 0,
      combinedText: lines,
      question: 'What changed?',
      reducerProfile: 'diff',
    });
    assert.equal(result.WasSummarized, true);
  });
});

test('analyzeCommandOutput default/smart reducer combines head and tail for large output without errors', async () => {
  await withTestEnvAndServer(async () => {
    const lines = Array.from({ length: 250 }, (_, i) => `info line ${i}`).join('\n');
    const result = await createAnalyzer().analyze({
      repoRoot: process.cwd(),
      outputKind: 'command',
      exitCode: 0,
      combinedText: lines,
      question: 'Summarize',
      reducerProfile: 'smart',
    });
    assert.equal(result.WasSummarized, true);
    assert.equal(typeof result.ReducedLogPath, 'string');
  });
});

test('analyzeCommandOutput with repeated lines compresses them', async () => {
  await withTestEnvAndServer(async () => {
    const lines = [
      ...Array.from({ length: 5 }, () => 'repeated line'),
      'unique line 1',
      ...Array.from({ length: 3 }, () => 'three times'),
      'unique line 2',
      ...Array.from({ length: 250 }, (_, i) => `filler ${i}`),
    ].join('\n');
    const result = await createAnalyzer().analyze({
      repoRoot: process.cwd(),
      outputKind: 'command',
      exitCode: 0,
      combinedText: lines,
      question: 'Summarize',
      reducerProfile: 'tail',
    });
    assert.equal(result.WasSummarized, true);
  });
});

test('analyzeCommandOutput with debug risk level uses risky-operation profile', async () => {
  await withTestEnvAndServer(async () => {
    const longOutput = 'Debug output line\n'.repeat(100);
    const result = await createAnalyzer().analyze({
      repoRoot: process.cwd(),
      outputKind: 'command',
      exitCode: 0,
      combinedText: longOutput,
      question: 'What happened?',
      riskLevel: 'debug',
    });
    assert.equal(result.WasSummarized, true);
  });
});

test('analyzeCommandOutput with nonzero exit code and errors reducer', async () => {
  await withTestEnvAndServer(async () => {
    const lines = [
      ...Array.from({ length: 120 }, (_, i) => `info line ${i}`),
      'fatal: could not connect to host',
      ...Array.from({ length: 120 }, (_, i) => `more info ${i}`),
    ].join('\n');
    const result = await createAnalyzer().analyze({
      repoRoot: process.cwd(),
      outputKind: 'command',
      exitCode: 1,
      combinedText: lines,
      question: 'What failed?',
      reducerProfile: 'errors',
    });
    assert.equal(result.WasSummarized, true);
  });
});
