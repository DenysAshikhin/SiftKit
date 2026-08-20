import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import { cleanCompiledOutputs, syncDistRuntime } from '../scripts/sync-dist-runtime.js';
import { mockConfig } from './_runtime-helpers.js';
import { readPackageJson } from './helpers/package-json.js';
import { mockRunRecord } from './helpers/mock-run-record.js';
import {
  DEFAULT_SPEC_BENCHMARK_CASES,
  FOCUSED3_SPEC_BENCHMARK_CASES,
  FOCUSED_SPEC_BENCHMARK_CASES,
  applySpeculativeCaseToConfig,
  buildBenchmarkCaseId,
  findBenchmarkRun,
  getLatestSpeculativeTotalsFromLogText,
  getSpeculativeLogDeltaTotals,
  getRunTelemetryStats,
  sortBenchmarkResults,
} from '../bench/spec-settings.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';

const DEFAULT_SPEC_BENCHMARK_PROMPTS = [
  'trace the managed-llama log-delta source for speculativeAcceptedTokens and speculativeGeneratedTokens; return exact file:line anchors from log parse through benchmark output',
  'trace the repo-search completion telemetry path end to end: starting at executeRepoSearchRequest, find where promptCacheTokens, promptEvalTokens, outputTokens, thinkingTokens, and requestDurationMs are computed, persisted to run_logs, and exposed through /dashboard/runs; return exact file:line anchors grouped by stage',
  'trace the canonical speculative metrics flow end to end: find where managed llama logs are parsed, where speculativeAcceptedTokens and speculativeGeneratedTokens are written to run_logs, and where dashboard metrics or idle summaries read those persisted fields; return exact file:line anchors grouped by parse, persist, and read stages',
  'trace the dynamic output token cap path end to end: find where remaining context tokens are computed, where max_tokens is derived for repo-search planner and terminal synthesis, and where summary/chat requests reuse the same cap; return exact file:line anchors grouped by repo-search, shared provider, and chat paths',
  'find where benchmark acceptanceRate and generationTokensPerSecond are computed and written to summary.csv/results.json; return exact file:line anchors and the exact source expressions used for each metric',
  'trace the spec benchmark restart lifecycle end to end: find where each case config is applied, where /status/restart is called, where health/readiness is awaited, and where managed llama run baselines are captured; return exact file:line anchors grouped by config, restart, health, and baseline capture',
  'verify that speculativeAcceptedTokens and speculativeGeneratedTokens in the spec benchmark come only from managed-llama log deltas; return exact file:line anchors for parse, delta, and output paths',
  'trace the repo-search prompt-budget and tool-output-limit path end to end: find where remaining token allowance is computed, where per tool call allowance is enforced, and where the \"requested output would consume\" failure text is emitted; return exact file:line anchors grouped by budget calculation, enforcement, and error reporting',
  'trace the managed llama restart/degraded-mode lifecycle end to end: find where llama_stop and llama_start are invoked, where startup warning/error markers trigger degraded mode, and where status/config endpoints surface server unavailable behavior; return exact file:line anchors grouped by stop/start, degraded mode, and HTTP surface',
] as const;
const DEFAULT_SPEC_BENCHMARK_PROMPT = DEFAULT_SPEC_BENCHMARK_PROMPTS[0];

const requireScriptModule = createRequire(path.join(process.cwd(), 'tests', 'benchmark-spec-settings.test.js'));
// The benchmark wrapper scripts are CommonJS .js without declarations, so the
// require() result is untyped at this boundary. loadScriptModule names the
// expected shape via a generic, keeping the call sites free of assertions.
function loadScriptModule<T>(id: string): T {
  return requireScriptModule(id);
}
const { normalizeForwardedArgs } = loadScriptModule<{
  normalizeForwardedArgs: (argv: string[]) => string[];
}>('../scripts/run-benchmark-spec-settings.cjs');
const { buildFocusedPowerShellArgs } = loadScriptModule<{
  buildFocusedPowerShellArgs: (repoRoot: string, forwardedArgv: string[]) => string[];
}>('../scripts/run-benchmark-spec-focused.cjs');
const { buildFocused3PowerShellArgs } = loadScriptModule<{
  buildFocused3PowerShellArgs: (repoRoot: string, forwardedArgv: string[]) => string[];
}>('../scripts/run-benchmark-spec-focused3.cjs');

const INTENTIONAL_SRC_DECLARATION_FILES = new Set<string>(['src/types/better-sqlite3.d.ts']);

function getTrackedSrcFiles(): string[] {
  const output = execFileSync('git', ['-C', process.cwd(), 'ls-files', '--', 'src'], {
    encoding: 'utf8',
  });

  return output.split(/\r?\n/u).filter((filePath) => filePath.length > 0);
}

function isForbiddenTrackedSrcArtifact(filePath: string): boolean {
  if (filePath.endsWith('.js')) {
    return true;
  }

  if (filePath.endsWith('.d.ts')) {
    return !INTENTIONAL_SRC_DECLARATION_FILES.has(filePath);
  }

  return false;
}

function getForbiddenTrackedSrcArtifacts(): string[] {
  const forbiddenArtifacts: string[] = [];

  for (const filePath of getTrackedSrcFiles()) {
    if (isForbiddenTrackedSrcArtifact(filePath)) {
      forbiddenArtifacts.push(filePath);
    }
  }

  return forbiddenArtifacts;
}

function readGitignoreLines(): string[] {
  return fs
    .readFileSync('.gitignore', 'utf8')
    .split(/\r?\n/u)
    .map((line) => line.trim());
}

test('src artifact guard allows only intentional ambient declaration files', () => {
  assert.equal(isForbiddenTrackedSrcArtifact('src/lib/time.js'), true);
  assert.equal(isForbiddenTrackedSrcArtifact('src/lib/time.d.ts'), true);
  assert.equal(isForbiddenTrackedSrcArtifact('src/types/better-sqlite3.d.ts'), false);
  assert.equal(isForbiddenTrackedSrcArtifact('src/lib/time.ts'), false);
});

test('src contains no tracked generated JavaScript or declaration siblings', () => {
  assert.deepEqual(getForbiddenTrackedSrcArtifacts(), []);
});

test('gitignore blocks generated src JavaScript and declaration siblings', () => {
  const gitignoreLines = readGitignoreLines();

  assert.equal(gitignoreLines.includes('src/**/*.js'), true);
  assert.equal(gitignoreLines.includes('src/**/*.d.ts'), true);
  assert.equal(gitignoreLines.includes('!src/types/better-sqlite3.d.ts'), true);
});

test('buildBenchmarkCaseId is stable and descriptive', () => {
  assert.equal(
    buildBenchmarkCaseId({
      speculativeNgramSizeN: 24,
      speculativeNgramSizeM: 64,
      speculativeNgramMinHits: 2,
      speculativeDraftMax: 48,
      speculativeDraftMin: 4,
    }),
    'n24-m64-h2-dmax48-dmin4',
  );
});

test('buildBenchmarkCaseId uses a dedicated id for the no-spec baseline case', () => {
  assert.equal(
    buildBenchmarkCaseId({
      speculativeEnabled: false,
      speculativeNgramSizeN: 24,
      speculativeNgramSizeM: 64,
      speculativeNgramMinHits: 2,
      speculativeDraftMax: 48,
      speculativeDraftMin: 4,
    }),
    'baseline-no-spec',
  );
});

test('findBenchmarkRun selects the nearest matching repo-search run after the run start', () => {
  const run = findBenchmarkRun([
    mockRunRecord({
      id: 'older',
      kind: 'repo_search',
      startedAtUtc: '2026-04-20T21:00:00.000Z',
      finishedAtUtc: '2026-04-20T21:00:20.000Z',
      title: DEFAULT_SPEC_BENCHMARK_PROMPT,
    }),
    mockRunRecord({
      id: 'winner',
      kind: 'repo_search',
      startedAtUtc: '2026-04-20T21:01:00.000Z',
      finishedAtUtc: '2026-04-20T21:01:20.000Z',
      title: DEFAULT_SPEC_BENCHMARK_PROMPT,
    }),
    mockRunRecord({
      id: 'later-same-prompt',
      kind: 'repo_search',
      startedAtUtc: '2026-04-20T21:05:00.000Z',
      finishedAtUtc: '2026-04-20T21:05:20.000Z',
      title: DEFAULT_SPEC_BENCHMARK_PROMPT,
    }),
    mockRunRecord({
      id: 'wrong-title',
      kind: 'repo_search',
      startedAtUtc: '2026-04-20T21:02:00.000Z',
      finishedAtUtc: '2026-04-20T21:02:20.000Z',
      title: 'different prompt',
    }),
  ], DEFAULT_SPEC_BENCHMARK_PROMPT, '2026-04-20T21:00:30.000Z');

  assert.equal(run?.id, 'winner');
});

test('getLatestSpeculativeTotalsFromLogText reads checkpointed cumulative statistics', () => {
  assert.deepEqual(
    getLatestSpeculativeTotalsFromLogText([
      'statistics ngram_mod: #calls(b,g,a) = 20 2985 131, #gen drafts = 131, #acc drafts = 131, #gen tokens = 6168, #acc tokens = 5837',
      'statistics ngram_mod: #calls(b,g,a) = 26 5746 137, #gen drafts = 137, #acc drafts = 137, #gen tokens = 6426, #acc tokens = 5895',
      'draft acceptance rate = 1.00000 ( 1946 accepted / 1946 generated)',
      'launching slot : {"id":0,"speculative":true}',
      'srv    load_model: speculative decoding will use checkpoints',
    ].join('\n')),
    {
      speculative: true,
      checkpointed: true,
      speculativeAcceptedTokens: 5895,
      speculativeGeneratedTokens: 6426,
      rawAcceptanceLine: 'draft acceptance rate = 1.00000 ( 1946 accepted / 1946 generated)',
    },
  );
});

test('getSpeculativeLogDeltaTotals converts cumulative log totals into per-request delta', () => {
  const baseline = getLatestSpeculativeTotalsFromLogText(
    'statistics ngram_mod: #calls(b,g,a) = 20 2985 131, #gen drafts = 131, #acc drafts = 131, #gen tokens = 6168, #acc tokens = 5837',
  );
  const current = getLatestSpeculativeTotalsFromLogText([
    'statistics ngram_mod: #calls(b,g,a) = 20 2985 131, #gen drafts = 131, #acc drafts = 131, #gen tokens = 6168, #acc tokens = 5837',
    'draft acceptance rate = 1.00000 (   47 accepted /    47 generated)',
    'draft acceptance rate = 1.00000 (   11 accepted /    11 generated)',
    'statistics ngram_mod: #calls(b,g,a) = 26 5746 137, #gen drafts = 137, #acc drafts = 137, #gen tokens = 6426, #acc tokens = 5895',
  ].join('\n'));

  assert.deepEqual(
    getSpeculativeLogDeltaTotals(current, baseline),
    {
      speculative: false,
      checkpointed: false,
      speculativeAcceptedTokens: 58,
      speculativeGeneratedTokens: 258,
      rawAcceptanceLine: 'draft acceptance rate = 1.00000 (   11 accepted /    11 generated)',
    },
  );
});

test('getRunTelemetryStats uses managed-log delta speculative totals instead of persisted run totals', () => {
  const run = mockRunRecord({
    promptCacheTokens: 200,
    promptEvalTokens: 50,
    promptEvalDurationMs: 10,
    outputTokens: 100,
    thinkingTokens: 40,
    generationDurationMs: 2_000,
    speculativeAcceptedTokens: 30,
    speculativeGeneratedTokens: 60,
  });
  const logDelta = {
    speculative: true,
    checkpointed: true,
    speculativeAcceptedTokens: 58,
    speculativeGeneratedTokens: 258,
    rawAcceptanceLine: 'draft acceptance rate = 1.00000 (   11 accepted /    11 generated)',
  };

  assert.deepEqual(
    getRunTelemetryStats(run, logDelta),
    {
      promptCacheTokens: 200,
      promptEvalTokens: 50,
      cacheHitRate: 0.8,
      speculativeAcceptedTokens: 58,
      speculativeGeneratedTokens: 258,
      acceptanceRate: 58 / 258,
      promptTokensPerSecond: 5000,
      generationTokensPerSecond: 70,
      outputTokens: 100,
      thinkingTokens: 40,
      generationDurationMs: 2_000,
    },
  );
});

test('getRunTelemetryStats leaves speculative totals null when managed-log delta is unavailable', () => {
  const run = mockRunRecord({
    promptCacheTokens: 200,
    promptEvalTokens: 50,
    promptEvalDurationMs: 10,
    outputTokens: 100,
    thinkingTokens: 40,
    generationDurationMs: 2_000,
    speculativeAcceptedTokens: 30,
    speculativeGeneratedTokens: 60,
  });

  assert.deepEqual(
    getRunTelemetryStats(run, null),
    {
      promptCacheTokens: 200,
      promptEvalTokens: 50,
      cacheHitRate: 0.8,
      speculativeAcceptedTokens: null,
      speculativeGeneratedTokens: null,
      acceptanceRate: null,
      promptTokensPerSecond: 5000,
      generationTokensPerSecond: 70,
      outputTokens: 100,
      thinkingTokens: 40,
      generationDurationMs: 2_000,
    },
  );
});

test('applySpeculativeCaseToConfig updates only the approved speculative settings', () => {
  const config = mockConfig({
    Server: {
      ModelPresets: {
        ActivePresetId: 'active',
        Presets: [
          {
            id: 'active',
            IdleAction: 'unload',
            SpeculativeEnabled: false,
            SpeculativeType: 'ngram-mod',
            SpeculativeNgramSizeN: 12,
            SpeculativeNgramSizeM: 34,
            SpeculativeNgramMinHits: 1,
            SpeculativeDraftMax: 5,
            SpeculativeDraftMin: 2,
            Temperature: 0.7,
          },
        ],
      },
    },
  });

  const updated = applySpeculativeCaseToConfig(config, {
    speculativeNgramSizeN: 24,
    speculativeNgramSizeM: 64,
    speculativeNgramMinHits: 2,
    speculativeDraftMax: 48,
    speculativeDraftMin: 4,
  });

  const preset = updated.Server.ModelPresets.Presets[0];
  assert.equal(preset.SpeculativeEnabled, true);
  assert.equal(preset.SpeculativeType, 'ngram-mod');
  assert.equal(preset.SpeculativeNgramSizeN, 24);
  assert.equal(preset.SpeculativeNgramSizeM, 64);
  assert.equal(preset.SpeculativeNgramMinHits, 2);
  assert.equal(preset.SpeculativeDraftMax, 48);
  assert.equal(preset.SpeculativeDraftMin, 4);
  assert.equal(preset.Temperature, 0.7);
});

test('applySpeculativeCaseToConfig updates the active managed llama preset used on restart', () => {
  const config = mockConfig({
    Server: {
      ModelPresets: {
        ActivePresetId: 'active',
        Presets: [
          {
            id: 'active',
            IdleAction: 'unload',
            SpeculativeEnabled: true,
            SpeculativeType: 'ngram-mod',
            SpeculativeNgramSizeN: 24,
            SpeculativeNgramSizeM: 64,
            SpeculativeNgramMinHits: 2,
            SpeculativeDraftMax: 48,
            SpeculativeDraftMin: 4,
          },
        ],
      },
    },
  });

  const updated = applySpeculativeCaseToConfig(config, {
    speculativeNgramSizeN: 16,
    speculativeNgramSizeM: 48,
    speculativeNgramMinHits: 1,
    speculativeDraftMax: 32,
    speculativeDraftMin: 2,
  });

  assert.equal(updated.Server.ModelPresets.Presets?.[0]?.SpeculativeNgramSizeN, 16);
  assert.equal(updated.Server.ModelPresets.Presets?.[0]?.SpeculativeNgramSizeM, 48);
  assert.equal(updated.Server.ModelPresets.Presets?.[0]?.SpeculativeNgramMinHits, 1);
  assert.equal(updated.Server.ModelPresets.Presets?.[0]?.SpeculativeDraftMax, 32);
  assert.equal(updated.Server.ModelPresets.Presets?.[0]?.SpeculativeDraftMin, 2);
});

test('applySpeculativeCaseToConfig can disable speculative decoding for the baseline run', () => {
  const config = mockConfig({
    Server: {
      ModelPresets: {
        ActivePresetId: 'active',
        Presets: [
          {
            id: 'active',
            IdleAction: 'unload',
            SpeculativeEnabled: true,
            SpeculativeNgramSizeN: 24,
            SpeculativeNgramSizeM: 64,
            SpeculativeNgramMinHits: 2,
            SpeculativeDraftMax: 48,
            SpeculativeDraftMin: 4,
          },
        ],
      },
    },
  });

  const updated = applySpeculativeCaseToConfig(config, {
    speculativeEnabled: false,
    speculativeNgramSizeN: 24,
    speculativeNgramSizeM: 64,
    speculativeNgramMinHits: 2,
    speculativeDraftMax: 48,
    speculativeDraftMin: 4,
  });

  assert.equal(updated.Server.ModelPresets.Presets[0].SpeculativeEnabled, false);
  assert.equal(updated.Server.ModelPresets.Presets[0].SpeculativeNgramSizeN, 24);
});

test('sortBenchmarkResults orders by generation tokens per second descending', () => {
  const sorted = sortBenchmarkResults([
    { caseId: 'slow', runMetrics: { generationTokensPerSecond: 60 } },
    { caseId: 'fast', runMetrics: { generationTokensPerSecond: 90 } },
  ]);

  assert.deepEqual(sorted.map((entry) => entry.caseId), ['fast', 'slow']);
});

test('DEFAULT_SPEC_BENCHMARK_CASES contains the approved baseline', () => {
  assert.equal(
    DEFAULT_SPEC_BENCHMARK_CASES.some((entry) => (
      entry.speculativeNgramSizeN === 24
      && entry.speculativeNgramSizeM === 64
      && entry.speculativeNgramMinHits === 2
      && entry.speculativeDraftMax === 48
      && entry.speculativeDraftMin === 4
    )),
    true,
  );
});

test('DEFAULT_SPEC_BENCHMARK_CASES appends a no-spec baseline case', () => {
  const lastEntry = DEFAULT_SPEC_BENCHMARK_CASES.at(-1);

  assert.ok(lastEntry);
  assert.equal(lastEntry.speculativeEnabled, false);
  assert.equal(buildBenchmarkCaseId(lastEntry), 'baseline-no-spec');
});

test('FOCUSED_SPEC_BENCHMARK_CASES contains baseline, current best, and eight nearby candidates', () => {
  assert.deepEqual(
    FOCUSED_SPEC_BENCHMARK_CASES.map(buildBenchmarkCaseId),
    [
      'baseline-no-spec',
      'n24-m64-h2-dmax64-dmin4',
      'n24-m64-h2-dmax56-dmin4',
      'n24-m64-h2-dmax72-dmin4',
      'n24-m64-h2-dmax80-dmin4',
      'n24-m64-h2-dmax64-dmin2',
      'n24-m64-h2-dmax64-dmin8',
      'n24-m48-h2-dmax64-dmin4',
      'n24-m80-h2-dmax64-dmin4',
      'n32-m64-h2-dmax64-dmin4',
    ],
  );
});

test('FOCUSED3_SPEC_BENCHMARK_CASES keeps trimmed-mean top two, baseline, and seven next candidates', () => {
  assert.deepEqual(
    FOCUSED3_SPEC_BENCHMARK_CASES.map(buildBenchmarkCaseId),
    [
      'baseline-no-spec',
      'n24-m80-h2-dmax64-dmin4',
      'n24-m64-h2-dmax72-dmin4',
      'n24-m72-h2-dmax64-dmin4',
      'n24-m88-h2-dmax64-dmin4',
      'n24-m80-h2-dmax56-dmin4',
      'n24-m80-h2-dmax72-dmin4',
      'n24-m80-h2-dmax80-dmin4',
      'n24-m72-h2-dmax72-dmin4',
      'n32-m64-h2-dmax64-dmin4',
      'n24-munset-hunset-dmax48-dmin12',
      'n24-munset-hunset-dmax64-dmin48',
    ],
  );
});

test('spec benchmark script exists and targets the CLI run-log path', () => {
  const script = fs.readFileSync('scripts/benchmark-siftkit-spec-settings.ps1', 'utf8');
  const invokeHelper = fs.readFileSync('scripts/invoke-repo-search-benchmark.cjs', 'utf8');

  for (const prompt of DEFAULT_SPEC_BENCHMARK_PROMPTS) {
    assert.match(script, new RegExp(prompt.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
  }
  assert.match(script, /invoke-repo-search-benchmark\.cjs/u);
  assert.match(invokeHelper, /repo-search/u);
  assert.match(invokeHelper, /--prompt/u);
  assert.match(script, /\/status\/restart/u);
  assert.match(script, /\/dashboard\/runs/u);
  assert.match(script, /\/dashboard\/admin\/managed-llama\/runs/u);
});

test('spec benchmark script invokes repo-search through the node helper without Start-Process argument flattening', () => {
  const script = fs.readFileSync('scripts/benchmark-siftkit-spec-settings.ps1', 'utf8');
  const invokeHelper = fs.readFileSync('scripts/invoke-repo-search-benchmark.cjs', 'utf8');

  assert.doesNotMatch(script, /-ArgumentList\s+@\('\.\\bin\\siftkit\.js',\s*'repo-search',\s*'--prompt',\s*\$PromptText\)/u);
  assert.doesNotMatch(script, /--prompt\s+\$PromptText/u);
  assert.match(script, /&\s+node(?:\.exe)?\s+\.\\scripts\\invoke-repo-search-benchmark\.cjs/u);
  assert.match(script, /\$promptPath\s*=\s*Join-Path\s+\$OutputDir\s+'prompt\.txt'/u);
  assert.match(script, /\[System\.IO\.File\]::WriteAllText\(\$promptPath,\s*\$PromptText,/u);
  assert.match(script, /--prompt-file\s+\$promptPath/u);
  assert.match(invokeHelper, /readArgValue\(process\.argv,\s*'--prompt-file'\)/u);
  assert.match(invokeHelper, /fs\.readFileSync\(promptFile,\s*'utf8'\)/u);
  assert.match(invokeHelper, /repo-search',\s*'--prompt',\s*prompt/u);
  assert.doesNotMatch(invokeHelper, /command:\s*`siftkit repo-search --prompt "\$\{prompt\}"`/u);
});

test('benchmark helper exercises the declared compiled CLI entrypoint', () => {
  const packageJson = fs.readFileSync('package.json', 'utf8');
  const invokeHelper = fs.readFileSync('scripts/invoke-repo-search-benchmark.cjs', 'utf8');
  const binPath = path.join(process.cwd(), 'dist', 'cli', 'main.js');

  assert.match(packageJson, /"siftkit"\s*:\s*"dist\/cli\/main\.js"/u);
  assert.equal(fs.existsSync(binPath), true);
  assert.equal(fs.existsSync(path.join(process.cwd(), 'bin', 'siftkit.js')), false);
  assert.equal(fs.existsSync(path.join(process.cwd(), 'bin', 'siftkit.cjs')), false);
  assert.match(invokeHelper, /path\.resolve\(repoRoot, 'dist', 'cli', 'main\.js'\)/u);
  assert.doesNotMatch(invokeHelper, /siftkit\.cjs/u);

  const wrapperResult = spawnSync(process.execPath, [binPath, '--help'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  assert.equal(wrapperResult.status, 0, wrapperResult.stderr);
  assert.match(wrapperResult.stdout, /siftkit repo-search/u);
});

test('spec benchmark script supports short verification runs and incremental artifact writes', () => {
  const script = fs.readFileSync('scripts/benchmark-siftkit-spec-settings.ps1', 'utf8');

  assert.match(script, /\[int\]\$CaseLimit\s*=\s*0/u);
  assert.match(script, /function\s+Write-BenchmarkArtifacts/u);
  assert.match(script, /function\s+Format-Duration/u);
  assert.match(script, /starting\s+\{2\}\s+\|\s+elapsed=/u);
  assert.match(script, /finished\s+\{2\}\s+\|\s+case=/u);
  assert.match(script, /Write-BenchmarkArtifacts\s+-OutputDirectory\s+\$outputDirectory\s+-Results\s+\$results/u);
});

test('spec benchmark script uses managed log deltas as the benchmark speculative metric source', () => {
  const script = fs.readFileSync('scripts/benchmark-siftkit-spec-settings.ps1', 'utf8');

  assert.match(script, /function\s+Get-SpeculativeLogDeltaTotals/u);
  assert.match(script, /\$baselineManagedRunDetail/u);
  assert.match(script, /\$speculativeLogMetrics\s*=\s*Get-SpeculativeLogDeltaTotals/u);
  assert.match(script, /Get-RunTelemetryStats\s+-Run\s+\$run\s+-SpeculativeLogMetrics\s+\$speculativeLogMetrics/u);
  assert.doesNotMatch(script, /Get-SpeculativeMetricsVerificationError/u);
  assert.doesNotMatch(script, /speculative-metrics-verification/u);
  assert.doesNotMatch(script, /\$Run\.speculativeAcceptedTokens/u);
  assert.doesNotMatch(script, /\$Run\.speculativeGeneratedTokens/u);
  assert.doesNotMatch(script, /^\s*logMetrics\s*=/mu);
});

test('spec benchmark script writes a single canonical speculative metrics block', () => {
  const script = fs.readFileSync('scripts/benchmark-siftkit-spec-settings.ps1', 'utf8');

  assert.doesNotMatch(script, /\$_\.logMetrics/u);
  assert.match(script, /function\s+Get-CacheHitRate/u);
  assert.match(script, /function\s+Get-AcceptanceRate/u);
  assert.match(script, /function\s+Get-PromptTokensPerSecond/u);
  assert.match(script, /function\s+Get-GenerationTokensPerSecond/u);
  assert.match(script, /\$runMetrics\s*=\s*\$_\.runMetrics/u);
  assert.match(script, /generationTokensPerSecond\s*=\s*if\s*\(\$null -ne \$runMetrics\)\s*\{\s*\$runMetrics\.generationTokensPerSecond/u);
  assert.match(script, /speculativeAcceptedTokens\s*=\s*if\s*\(\$null -ne \$runMetrics\)\s*\{\s*\$runMetrics\.speculativeAcceptedTokens/u);
  assert.match(script, /speculativeGeneratedTokens\s*=\s*if\s*\(\$null -ne \$runMetrics\)\s*\{\s*\$runMetrics\.speculativeGeneratedTokens/u);
  assert.match(script, /cacheHitRate\s*=\s*Get-CacheHitRate/u);
  assert.match(script, /acceptanceRate\s*=\s*Get-AcceptanceRate/u);
  assert.match(script, /promptTokensPerSecond\s*=\s*Get-PromptTokensPerSecond/u);
  assert.match(script, /generationTokensPerSecond\s*=\s*Get-GenerationTokensPerSecond/u);
});

test('spec benchmark script includes a final no-spec baseline case', () => {
  const script = fs.readFileSync('scripts/benchmark-siftkit-spec-settings.ps1', 'utf8');

  assert.match(script, /SpeculativeEnabled\s*=\s*\$false/u);
  assert.match(script, /baseline-no-spec/u);
});

test('spec benchmark script supports the focused ten-case set without changing the default set', () => {
  const script = fs.readFileSync('scripts/benchmark-siftkit-spec-settings.ps1', 'utf8');

  assert.match(script, /\[ValidateSet\('Default',\s*'Focused10',\s*'Focused3'\)\]/u);
  assert.match(script, /function\s+Get-FocusedCases/u);
  assert.match(script, /\$CaseSet\s+-eq\s+'Focused10'/u);
  assert.match(script, /SpeculativeDraftMax\s*=\s*56/u);
  assert.match(script, /SpeculativeDraftMax\s*=\s*72/u);
  assert.match(script, /SpeculativeDraftMax\s*=\s*80/u);
  assert.match(script, /SpeculativeNgramSizeM\s*=\s*80/u);
  assert.match(script, /SpeculativeNgramSizeN\s*=\s*32;\s*SpeculativeNgramSizeM\s*=\s*64;\s*SpeculativeNgramMinHits\s*=\s*2;\s*SpeculativeDraftMax\s*=\s*64/u);
});

test('spec benchmark script supports Focused3 with the next throughput candidates', () => {
  const script = fs.readFileSync('scripts/benchmark-siftkit-spec-settings.ps1', 'utf8');

  assert.match(script, /function\s+Get-Focused3Cases/u);
  assert.match(script, /\$CaseSet\s+-eq\s+'Focused3'/u);
  assert.match(script, /SpeculativeNgramSizeM\s*=\s*80;\s*SpeculativeNgramMinHits\s*=\s*2;\s*SpeculativeDraftMax\s*=\s*64/u);
  assert.match(script, /SpeculativeNgramSizeM\s*=\s*64;\s*SpeculativeNgramMinHits\s*=\s*2;\s*SpeculativeDraftMax\s*=\s*72/u);
  assert.match(script, /SpeculativeNgramSizeM\s*=\s*72;\s*SpeculativeNgramMinHits\s*=\s*2;\s*SpeculativeDraftMax\s*=\s*64/u);
  assert.match(script, /SpeculativeNgramSizeM\s*=\s*88;\s*SpeculativeNgramMinHits\s*=\s*2;\s*SpeculativeDraftMax\s*=\s*64/u);
  assert.match(script, /SpeculativeNgramSizeM\s*=\s*80;\s*SpeculativeNgramMinHits\s*=\s*2;\s*SpeculativeDraftMax\s*=\s*56/u);
  assert.match(script, /SpeculativeNgramSizeM\s*=\s*80;\s*SpeculativeNgramMinHits\s*=\s*2;\s*SpeculativeDraftMax\s*=\s*72/u);
  assert.match(script, /SpeculativeNgramSizeM\s*=\s*80;\s*SpeculativeNgramMinHits\s*=\s*2;\s*SpeculativeDraftMax\s*=\s*80/u);
  assert.match(script, /SpeculativeNgramSizeM\s*=\s*-1;\s*SpeculativeNgramMinHits\s*=\s*-1;\s*SpeculativeDraftMax\s*=\s*48;\s*SpeculativeDraftMin\s*=\s*12/u);
  assert.match(script, /SpeculativeNgramSizeM\s*=\s*-1;\s*SpeculativeNgramMinHits\s*=\s*-1;\s*SpeculativeDraftMax\s*=\s*64;\s*SpeculativeDraftMin\s*=\s*48/u);
});

test('spec benchmark script updates the active model preset before restart', () => {
  const script = fs.readFileSync('scripts/benchmark-siftkit-spec-settings.ps1', 'utf8');

  assert.match(script, /function\s+Get-ActiveModelPreset/u);
  assert.match(script, /\$ModelPresets\.ActivePresetId/u);
  assert.match(script, /\$activePreset\.SpeculativeNgramSizeN/u);
});

test('package benchmark command uses a node wrapper instead of forwarding prompt args directly to PowerShell', () => {
  const pkg = readPackageJson();

  assert.match(String(pkg.scripts?.['benchmark:spec-settings'] || ''), /node\s+\.\\scripts\\run-benchmark-spec-settings\.cjs/u);
  assert.doesNotMatch(String(pkg.scripts?.['benchmark:spec-settings'] || ''), /&&/u);
});

test('package focused spec benchmark command preserves the old command and selects Focused10', () => {
  const pkg = readPackageJson();

  assert.equal(String(pkg.scripts?.['benchmark:spec-settings']), 'node .\\scripts\\run-benchmark-spec-settings.cjs');
  assert.equal(String(pkg.scripts?.['benchmark:spec-focused']), 'node .\\scripts\\run-benchmark-spec-focused.cjs');
  assert.deepEqual(
    buildFocusedPowerShellArgs('C:\\repo', ['-CaseLimit', '1']).slice(-4),
    ['-CaseSet', 'Focused10', '-CaseLimit', '1'],
  );
});

test('package focused3 spec benchmark command preserves existing commands and selects Focused3', () => {
  const pkg = readPackageJson();

  assert.equal(String(pkg.scripts?.['benchmark:spec-settings']), 'node .\\scripts\\run-benchmark-spec-settings.cjs');
  assert.equal(String(pkg.scripts?.['benchmark:spec-focused']), 'node .\\scripts\\run-benchmark-spec-focused.cjs');
  assert.equal(String(pkg.scripts?.['benchmark:spec-focused3']), 'node .\\scripts\\run-benchmark-spec-focused3.cjs');
  assert.deepEqual(
    buildFocused3PowerShellArgs('C:\\repo', ['-CaseLimit', '1']).slice(-4),
    ['-CaseSet', 'Focused3', '-CaseLimit', '1'],
  );
});

test('package build command syncs dist runtime output after compiling TypeScript', () => {
  const pkg = readPackageJson();

  assert.match(
    String(pkg.scripts?.build || ''),
    /node\s+--experimental-strip-types\s+\.\\scripts\\sync-dist-runtime\.ts/u,
  );
  assert.doesNotMatch(String(pkg.scripts?.build || ''), /experimental-default-type/u);
});

test('package build:test command runs the TypeScript build script with Node type stripping', () => {
  const pkg = readPackageJson();

  assert.match(
    String(pkg.scripts?.['build:test'] || ''),
    /node\s+--experimental-strip-types\s+\.\\scripts\\build-test\.ts/u,
  );
  assert.doesNotMatch(String(pkg.scripts?.['build:test'] || ''), /experimental-default-type/u);
});

test('scripts package boundary marks standalone TypeScript entrypoints as ESM', () => {
  const packageJson = fs.readFileSync('package.json', 'utf8');

  assert.doesNotMatch(packageJson, /"type":\s*"module"/u);
  assert.match(fs.readFileSync(path.join('scripts', 'package.json'), 'utf8'), /"type":\s*"module"/u);
});

test('package has no broad runtime alias or root ESM compatibility path', () => {
  const packageJson = fs.readFileSync('package.json', 'utf8');

  assert.doesNotMatch(packageJson, /#siftkit-runtime/u);
  assert.doesNotMatch(packageJson, /"type":\s*"module"/u);
});

test('compiled runtime uses one flattened ESM package marker without aliases', () => {
  const distPackageJson = fs.readFileSync(path.join('dist', 'package.json'), 'utf8');

  assert.match(distPackageJson, /"type":\s*"module"/u);
  assert.doesNotMatch(distPackageJson, /#siftkit-runtime/u);
  assert.equal(fs.existsSync(path.join('dist', 'scripts', 'package.json')), false);
});

test('native type-stripped source build scripts are warning-free under their ESM boundary', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      '--input-type=module',
      '-e',
      "await import('./scripts/build-test.ts'); await import('./scripts/sync-dist-runtime.ts')",
    ],
    { cwd: process.cwd(), encoding: 'utf8' },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /MODULE_TYPELESS_PACKAGE_JSON/u);
});

test('compiled purge-temp-dirs module can be evaluated as ESM without purging OS temp', async () => {
  const moduleUrl = pathToFileURL(path.resolve('dist', 'scripts', 'purge-temp-dirs.js')).href;

  await import(moduleUrl);
});

test('compiled test runner executes after source staging is removed', () => {
  const result = spawnSync(
    process.execPath,
    [path.join('dist', 'test-runner', 'run-tests.js'), path.join('tests', 'fixtures', 'settles-immediately.test.ts')],
    { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, NODE_TEST_CONTEXT: undefined } },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(path.join('dist', 'src')), false);
});

test('explicit ESM source execution emits no typeless-package warning', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      '--input-type=module',
      '-e',
      "await import('./scripts/sync-dist-runtime.ts')",
    ],
    { cwd: process.cwd(), encoding: 'utf8' },
  );

  assert.equal(result.status, 0);
  assert.doesNotMatch(result.stderr, /MODULE_TYPELESS_PACKAGE_JSON/u);
});

test('build:test reuses only a current content-addressed artifact set', () => {
  const buildScript = fs.readFileSync('scripts/build-test.ts', 'utf8');

  assert.match(buildScript, /state\.kind === 'current'/u);
  assert.match(buildScript, /isTestsOnlyChange\(state\)/u);
  assert.match(buildScript, /\['--clean'\]/u);
});

test('scripts TypeScript build includes both build entrypoints and purge', () => {
  const scriptsConfig = fs.readFileSync('tsconfig.scripts.json', 'utf8');

  assert.match(scriptsConfig, /"scripts\/build-test\.ts"/u);
  assert.match(scriptsConfig, /"scripts\/sync-dist-runtime\.ts"/u);
  assert.match(scriptsConfig, /"scripts\/purge-temp-dirs\.ts"/u);
  assert.match(scriptsConfig, /"scripts\/purge-temp-dirs-main\.ts"/u);
});

test('package test command runs prepared artifacts without building or typechecking', () => {
  const pkg = readPackageJson();

  assert.equal(String(pkg.scripts?.['typecheck:test']), 'tsc -p .\\tsconfig.test.json --noEmit');
  assert.equal(String(pkg.scripts?.test), 'node .\\dist\\test-runner\\run-tests.js');
  assert.doesNotMatch(String(pkg.scripts?.test || ''), /build|typecheck/u);
});

test('package typecheck command is available for repo, scripts, dashboard, bench, tests, and dashboard-test', () => {
  const pkg = readPackageJson();

  assert.equal(
    String(pkg.scripts?.typecheck),
    // tsconfig.json and tsconfig.scripts.json also drive emitting builds, so their incremental
    // state is attached here on the CLI rather than in the configs those builds share.
    'tsc -b .\\packages\\contracts\\tsconfig.json && tsc -p .\\tsconfig.json --noEmit --incremental --tsBuildInfoFile .tscache\\main.tsbuildinfo && tsc -p .\\tsconfig.scripts.json --noEmit --incremental --tsBuildInfoFile .tscache\\scripts.tsbuildinfo && tsc -p .\\dashboard\\tsconfig.json --noEmit && npm run typecheck:bench && npm run typecheck:test && npm run typecheck:dashboard-test && npm run typecheck:analysis && npm run lint',
  );
  assert.equal(String(pkg.scripts?.['typecheck:bench']), 'tsc -p .\\tsconfig.bench.json --noEmit');
  assert.equal(String(pkg.scripts?.['typecheck:dashboard-test']), 'tsc -p .\\dashboard\\tsconfig.test.json --noEmit');
  assert.equal(String(pkg.scripts?.['typecheck:analysis']), 'tsc -p .\\tsconfig.analysis.json --noEmit');
});

test('syncDistRuntime copies current output and removes its source staging directory', () => {
  const tempRoot = createManagedTempDir('sync-dist-runtime-');
  const sourceRoot = path.join(tempRoot, 'dist', 'src');
  const targetRoot = path.join(tempRoot, 'dist');

  fs.mkdirSync(path.join(sourceRoot, 'status-server'), { recursive: true });
  fs.mkdirSync(path.join(targetRoot, 'status-server'), { recursive: true });
  fs.writeFileSync(path.join(sourceRoot, 'status-server', 'dashboard-runs.js'), 'fresh');
  fs.writeFileSync(path.join(targetRoot, 'status-server', 'dashboard-runs.js'), 'stale');
  fs.writeFileSync(path.join(targetRoot, 'status-server', 'deleted-worker.js'), 'obsolete');

  syncDistRuntime(sourceRoot, targetRoot);

  assert.equal(fs.readFileSync(path.join(targetRoot, 'status-server', 'dashboard-runs.js'), 'utf8'), 'fresh');
  assert.equal(fs.existsSync(path.join(targetRoot, 'status-server', 'deleted-worker.js')), false);
  assert.equal(fs.existsSync(sourceRoot), false);
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('cleanCompiledOutputs removes the complete dist output tree', () => {
  const tempRoot = createManagedTempDir('clean-compiled-runtime-');
  const distRoot = path.join(tempRoot, 'dist');
  fs.mkdirSync(path.join(distRoot, 'src'), { recursive: true });
  fs.mkdirSync(path.join(distRoot, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(distRoot, 'src', 'stale.js'), 'obsolete');
  fs.writeFileSync(path.join(distRoot, 'scripts', 'stale.js'), 'obsolete');
  fs.writeFileSync(path.join(distRoot, 'deleted-top-level.js'), 'obsolete');
  fs.writeFileSync(path.join(distRoot, 'keep.txt'), 'obsolete');

  cleanCompiledOutputs(distRoot);

  assert.equal(fs.existsSync(distRoot), false);
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('benchmark wrapper regroups multi-word option values after npm strips quotes on Windows', () => {
  assert.deepEqual(
    normalizeForwardedArgs([
      '-Prompt',
      'where',
      'is',
      'buildPrompt',
      'defined?',
      '-CaseLimit',
      '1',
      '-OutputRoot',
      '.\\eval\\results\\spec_bench_repro',
    ]),
    [
      '-Prompt',
      'where is buildPrompt defined?',
      '-CaseLimit',
      '1',
      '-OutputRoot',
      '.\\eval\\results\\spec_bench_repro',
    ],
  );
});

test('benchmark wrapper preserves Prompt as a value option while keeping the trailing flags intact', () => {
  assert.deepEqual(
    normalizeForwardedArgs([
      '-Prompt',
      'where',
      'is',
      'buildPrompt',
      'defined?',
      '-CaseLimit',
      '2',
    ]),
    [
      '-Prompt',
      'where is buildPrompt defined?',
      '-CaseLimit',
      '2',
    ],
  );
});

test('spec benchmark script runs nine benchmark prompts per case and averages metrics', () => {
  const script = fs.readFileSync('scripts/benchmark-siftkit-spec-settings.ps1', 'utf8');

  assert.equal(DEFAULT_SPEC_BENCHMARK_PROMPTS.length, 9);
  assert.match(script, /function\s+Get-BenchmarkPrompts/u);
  assert.match(script, /\$script:DefaultBenchmarkPrompts\s*=\s*@\(/u);
  assert.match(script, /for\s*\(\$promptIndex\s*=\s*0;\s*\$promptIndex\s*-lt\s*\$benchmarkPrompts\.Count;\s*\$promptIndex\s*\+=\s*1\)/u);
  assert.match(script, /'prompt-\{0:00\}'/u);
  assert.match(script, /function\s+Get-AverageCaseResult/u);
  assert.match(script, /sampleCount\s*=\s*\$_.sampleCount/u);
});

test('spec benchmark script averaging helpers tolerate missing samples from failed attempts', () => {
  const script = fs.readFileSync('scripts/benchmark-siftkit-spec-settings.ps1', 'utf8');

  assert.match(script, /function\s+Get-AverageNumber[\s\S]*?\[AllowNull\(\)\][\s\S]*?\[object\[\]\]\$Values\s*=\s*@\(\)/u);
  assert.match(script, /function\s+Get-FirstNonNullValue[\s\S]*?\[AllowNull\(\)\][\s\S]*?\[object\[\]\]\$Values\s*=\s*@\(\)/u);
  assert.match(script, /function\s+Join-NonEmptyValues[\s\S]*?\[AllowNull\(\)\][\s\S]*?\[object\[\]\]\$Values\s*=\s*@\(\)/u);
});

test('spec benchmark script avoids inline casted if-expressions that break Windows PowerShell', () => {
  const script = fs.readFileSync('scripts/benchmark-siftkit-spec-settings.ps1', 'utf8');

  assert.doesNotMatch(script, /\[(?:double|int)\]\(if\s*\(/u);
});

test('spec benchmark script includes safe process-tree and port cleanup like the ordered safe runner', () => {
  const script = fs.readFileSync('scripts/benchmark-siftkit-spec-settings.ps1', 'utf8');

  assert.match(script, /function\s+Get-ListenerPids/u);
  assert.match(script, /function\s+Stop-Ports/u);
  assert.match(script, /taskkill\s+\/PID\s+\$processId\s+\/T\s+\/F/u);
  assert.match(script, /function\s+Start-CleanupWatchdog/u);
  assert.match(script, /BenchmarkPid/u);
  assert.match(script, /Stop-Ports\s+-Ports\s+@\(4765,\s*8097\)/u);
});

test('spec benchmark script retries run discovery before marking a prompt sample missing', () => {
  const script = fs.readFileSync('scripts/benchmark-siftkit-spec-settings.ps1', 'utf8');

  assert.match(script, /function\s+Wait-BenchmarkRun/u);
  assert.match(script, /Start-Sleep\s+-Milliseconds/u);
  assert.match(script, /\$run\s*=\s*Wait-BenchmarkRun\s+-PromptText/u);
});
