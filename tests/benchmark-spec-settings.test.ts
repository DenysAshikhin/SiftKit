import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';

import { getSessionTelemetryStats } from '../dashboard/src/lib/format';
import type { DashboardConfig } from '../dashboard/src/types';
import {
  DEFAULT_SPEC_BENCHMARK_CASES,
  applySpeculativeCaseToConfig,
  buildBenchmarkCaseId,
  findBenchmarkRun,
  getLatestSpeculativeTotalsFromLogText,
  getSpeculativeLogDeltaTotals,
  getRunTelemetryStats,
  sortBenchmarkResults,
} from '../src/benchmark-spec-settings';

const DEFAULT_SPEC_BENCHMARK_PROMPTS = [
  'find all non-status-server call sites that pass speculativeAcceptedTokens or speculativeGeneratedTokens into sendStatusUpdate/status backend options; return exact file:line anchors and the source values used',
  'trace the repo-search completion telemetry path end to end: starting at executeRepoSearchRequest, find where promptCacheTokens, promptEvalTokens, outputTokens, thinkingTokens, and requestDurationMs are computed, persisted to run_logs, and exposed through /dashboard/runs; return exact file:line anchors grouped by stage',
  'trace the canonical speculative metrics flow end to end: find where managed llama logs are parsed, where speculativeAcceptedTokens and speculativeGeneratedTokens are written to run_logs, and where dashboard metrics or idle summaries read those persisted fields; return exact file:line anchors grouped by parse, persist, and read stages',
  'trace the dynamic output token cap path end to end: find where remaining context tokens are computed, where max_tokens is derived for repo-search planner and terminal synthesis, and where summary/chat requests reuse the same cap; return exact file:line anchors grouped by repo-search, shared provider, and chat paths',
  'find where benchmark acceptanceRate and generationTokensPerSecond are computed and written to summary.csv/results.json; return exact file:line anchors and the exact source expressions used for each metric',
  'trace the spec benchmark restart lifecycle end to end: find where each case config is applied, where /status/restart is called, where health/readiness is awaited, and where managed llama run baselines are captured; return exact file:line anchors grouped by config, restart, health, and baseline capture',
  'find every non-test code path that can populate speculativeAcceptedTokens or speculativeGeneratedTokens on a run/session/artifact object; return exact file:line anchors and identify whether each source is managed-llama log delta, persisted run_logs, request payload, or fallback artifact data',
  'trace the repo-search prompt-budget and tool-output-limit path end to end: find where remaining token allowance is computed, where per tool call allowance is enforced, and where the \"requested output would consume\" failure text is emitted; return exact file:line anchors grouped by budget calculation, enforcement, and error reporting',
  'trace the managed llama restart/degraded-mode lifecycle end to end: find where llama_stop and llama_start are invoked, where startup warning/error markers trigger degraded mode, and where status/config endpoints surface server unavailable behavior; return exact file:line anchors grouped by stop/start, degraded mode, and HTTP surface',
] as const;
const DEFAULT_SPEC_BENCHMARK_PROMPT = DEFAULT_SPEC_BENCHMARK_PROMPTS[0];

const require = createRequire(import.meta.url);
const { normalizeForwardedArgs } = require('../scripts/run-benchmark-spec-settings.js') as {
  normalizeForwardedArgs: (argv: string[]) => string[];
};
const { syncDistRuntime } = require('../scripts/sync-dist-runtime.js') as {
  syncDistRuntime: (sourceRoot: string, targetRoot: string) => void;
};

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
    {
      id: 'older',
      kind: 'repo_search',
      startedAtUtc: '2026-04-20T21:00:00.000Z',
      finishedAtUtc: '2026-04-20T21:00:20.000Z',
      title: DEFAULT_SPEC_BENCHMARK_PROMPT,
    },
    {
      id: 'winner',
      kind: 'repo_search',
      startedAtUtc: '2026-04-20T21:01:00.000Z',
      finishedAtUtc: '2026-04-20T21:01:20.000Z',
      title: DEFAULT_SPEC_BENCHMARK_PROMPT,
    },
    {
      id: 'later-same-prompt',
      kind: 'repo_search',
      startedAtUtc: '2026-04-20T21:05:00.000Z',
      finishedAtUtc: '2026-04-20T21:05:20.000Z',
      title: DEFAULT_SPEC_BENCHMARK_PROMPT,
    },
    {
      id: 'wrong-title',
      kind: 'repo_search',
      startedAtUtc: '2026-04-20T21:02:00.000Z',
      finishedAtUtc: '2026-04-20T21:02:20.000Z',
      title: 'different prompt',
    },
  ] as never, DEFAULT_SPEC_BENCHMARK_PROMPT, '2026-04-20T21:00:30.000Z');

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

test('getRunTelemetryStats matches the UI-equivalent header metrics for a single repo-search turn', () => {
  const run = {
    promptCacheTokens: 200,
    promptEvalTokens: 50,
    promptEvalDurationMs: 10,
    outputTokens: 100,
    thinkingTokens: 40,
    generationDurationMs: 2_000,
    speculativeAcceptedTokens: 30,
    speculativeGeneratedTokens: 60,
  } as never;
  const session = {
    id: 'session-1',
    title: 'Session',
    model: 'test-model',
    contextWindowTokens: 100,
    presetId: 'repo-search',
    mode: 'repo-search',
    condensedSummary: '',
    createdAtUtc: '2026-04-16T11:00:00.000Z',
    updatedAtUtc: '2026-04-16T12:00:00.000Z',
    messages: [
      { id: 'user-1', role: 'user', content: DEFAULT_SPEC_BENCHMARK_PROMPT, inputTokensEstimate: 0, outputTokensEstimate: 0, thinkingTokens: 0, createdAtUtc: '2026-04-16T11:59:59.000Z', sourceRunId: null },
      {
        id: 'assistant-1',
        role: 'assistant',
        content: 'answer',
        inputTokensEstimate: 0,
        outputTokensEstimate: 100,
        thinkingTokens: 40,
        promptCacheTokens: 200,
        promptEvalTokens: 50,
        promptTokensPerSecond: null,
        generationTokensPerSecond: null,
        promptEvalDurationMs: 10,
        generationDurationMs: 2_000,
        requestStartedAtUtc: null,
        thinkingStartedAtUtc: null,
        thinkingEndedAtUtc: null,
        answerStartedAtUtc: null,
        answerEndedAtUtc: null,
        speculativeAcceptedTokens: 30,
        speculativeGeneratedTokens: 60,
        createdAtUtc: '2026-04-16T12:00:00.000Z',
        sourceRunId: null,
      },
    ],
  } as never;

  const sessionStats = getSessionTelemetryStats(session);
  assert.deepEqual(
    getRunTelemetryStats(run),
    {
      promptCacheTokens: sessionStats.promptCacheTokens,
      promptEvalTokens: sessionStats.promptEvalTokens,
      cacheHitRate: sessionStats.cacheHitRate,
      speculativeAcceptedTokens: sessionStats.speculativeAcceptedTokens,
      speculativeGeneratedTokens: sessionStats.speculativeGeneratedTokens,
      acceptanceRate: sessionStats.acceptanceRate,
      promptTokensPerSecond: sessionStats.promptTokensPerSecond,
      generationTokensPerSecond: sessionStats.generationTokensPerSecond,
      outputTokens: 100,
      thinkingTokens: 40,
      generationDurationMs: 2_000,
    },
  );
});

test('getRunTelemetryStats preserves null speculative totals when the run has no canonical speculative metrics', () => {
  const run = {
    promptCacheTokens: 200,
    promptEvalTokens: 50,
    promptEvalDurationMs: 10,
    outputTokens: 100,
    thinkingTokens: 40,
    generationDurationMs: 2_000,
    speculativeAcceptedTokens: null,
    speculativeGeneratedTokens: null,
  } as never;

  assert.deepEqual(
    getRunTelemetryStats(run),
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
  const config = {
    Server: {
      LlamaCpp: {
        SpeculativeEnabled: false,
        SpeculativeType: 'ngram-mod',
        SpeculativeNgramSizeN: 12,
        SpeculativeNgramSizeM: 34,
        SpeculativeNgramMinHits: 1,
        SpeculativeDraftMax: 5,
        SpeculativeDraftMin: 2,
        Temperature: 0.7,
      },
    },
  } as DashboardConfig;

  const updated = applySpeculativeCaseToConfig(config, {
    speculativeNgramSizeN: 24,
    speculativeNgramSizeM: 64,
    speculativeNgramMinHits: 2,
    speculativeDraftMax: 48,
    speculativeDraftMin: 4,
  });

  assert.equal(updated.Server.LlamaCpp.SpeculativeEnabled, true);
  assert.equal(updated.Server.LlamaCpp.SpeculativeType, 'ngram-mod');
  assert.equal(updated.Server.LlamaCpp.SpeculativeNgramSizeN, 24);
  assert.equal(updated.Server.LlamaCpp.SpeculativeNgramSizeM, 64);
  assert.equal(updated.Server.LlamaCpp.SpeculativeNgramMinHits, 2);
  assert.equal(updated.Server.LlamaCpp.SpeculativeDraftMax, 48);
  assert.equal(updated.Server.LlamaCpp.SpeculativeDraftMin, 4);
  assert.equal(updated.Server.LlamaCpp.Temperature, 0.7);
});

test('applySpeculativeCaseToConfig updates the active managed llama preset used on restart', () => {
  const config = {
    Server: {
      LlamaCpp: {
        SpeculativeEnabled: true,
        SpeculativeType: 'ngram-mod',
        SpeculativeNgramSizeN: 24,
        SpeculativeNgramSizeM: 64,
        SpeculativeNgramMinHits: 2,
        SpeculativeDraftMax: 48,
        SpeculativeDraftMin: 4,
        ActivePresetId: 'active',
        Presets: [
          {
            id: 'active',
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
  } as DashboardConfig;

  const updated = applySpeculativeCaseToConfig(config, {
    speculativeNgramSizeN: 16,
    speculativeNgramSizeM: 48,
    speculativeNgramMinHits: 1,
    speculativeDraftMax: 32,
    speculativeDraftMin: 2,
  });

  assert.equal(updated.Server.LlamaCpp.Presets?.[0]?.SpeculativeNgramSizeN, 16);
  assert.equal(updated.Server.LlamaCpp.Presets?.[0]?.SpeculativeNgramSizeM, 48);
  assert.equal(updated.Server.LlamaCpp.Presets?.[0]?.SpeculativeNgramMinHits, 1);
  assert.equal(updated.Server.LlamaCpp.Presets?.[0]?.SpeculativeDraftMax, 32);
  assert.equal(updated.Server.LlamaCpp.Presets?.[0]?.SpeculativeDraftMin, 2);
});

test('applySpeculativeCaseToConfig can disable speculative decoding for the baseline run', () => {
  const config = {
    Server: {
      LlamaCpp: {
        SpeculativeEnabled: true,
        SpeculativeNgramSizeN: 24,
        SpeculativeNgramSizeM: 64,
        SpeculativeNgramMinHits: 2,
        SpeculativeDraftMax: 48,
        SpeculativeDraftMin: 4,
      },
    },
  } as DashboardConfig;

  const updated = applySpeculativeCaseToConfig(config, {
    speculativeEnabled: false,
    speculativeNgramSizeN: 24,
    speculativeNgramSizeM: 64,
    speculativeNgramMinHits: 2,
    speculativeDraftMax: 48,
    speculativeDraftMin: 4,
  });

  assert.equal(updated.Server.LlamaCpp.SpeculativeEnabled, false);
  assert.equal(updated.Server.LlamaCpp.SpeculativeNgramSizeN, 24);
});

test('sortBenchmarkResults orders by generation tokens per second descending', () => {
  const sorted = sortBenchmarkResults([
    { caseId: 'slow', runMetrics: { generationTokensPerSecond: 60 } },
    { caseId: 'fast', runMetrics: { generationTokensPerSecond: 90 } },
  ] as never);

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

  assert.equal(lastEntry?.speculativeEnabled, false);
  assert.equal(buildBenchmarkCaseId(lastEntry as never), 'baseline-no-spec');
});

test('spec benchmark script exists and targets the CLI run-log path', () => {
  const script = fs.readFileSync('scripts/benchmark-siftkit-spec-settings.ps1', 'utf8');
  const invokeHelper = fs.readFileSync('scripts/invoke-repo-search-benchmark.js', 'utf8');

  for (const prompt of DEFAULT_SPEC_BENCHMARK_PROMPTS) {
    assert.match(script, new RegExp(prompt.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
  }
  assert.match(script, /invoke-repo-search-benchmark\.js/u);
  assert.match(invokeHelper, /repo-search/u);
  assert.match(invokeHelper, /--prompt/u);
  assert.match(script, /\/status\/restart/u);
  assert.match(script, /\/dashboard\/runs/u);
  assert.match(script, /\/dashboard\/admin\/managed-llama\/runs/u);
});

test('spec benchmark script invokes repo-search through the node helper without Start-Process argument flattening', () => {
  const script = fs.readFileSync('scripts/benchmark-siftkit-spec-settings.ps1', 'utf8');

  assert.doesNotMatch(script, /-ArgumentList\s+@\('\.\\bin\\siftkit\.js',\s*'repo-search',\s*'--prompt',\s*\$PromptText\)/u);
  assert.match(script, /&\s+node(?:\.exe)?\s+\.\\scripts\\invoke-repo-search-benchmark\.js/u);
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

test('spec benchmark script keeps log deltas as internal verification only', () => {
  const script = fs.readFileSync('scripts/benchmark-siftkit-spec-settings.ps1', 'utf8');

  assert.match(script, /function\s+Get-SpeculativeLogDeltaTotals/u);
  assert.match(script, /\$baselineManagedRunDetail/u);
  assert.match(script, /\$verifiedLogMetrics\s*=\s*Get-SpeculativeLogDeltaTotals/u);
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

test('spec benchmark script updates the active managed llama preset before restart', () => {
  const script = fs.readFileSync('scripts/benchmark-siftkit-spec-settings.ps1', 'utf8');

  assert.match(script, /function\s+Get-ActiveManagedPreset/u);
  assert.match(script, /\$ServerLlamaCpp\.ActivePresetId/u);
  assert.match(script, /\$activePreset\.SpeculativeNgramSizeN/u);
});

test('package benchmark command uses a node wrapper instead of forwarding prompt args directly to PowerShell', () => {
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8')) as { scripts?: Record<string, string> };

  assert.match(String(pkg.scripts?.['benchmark:spec-settings'] || ''), /node\s+\.\\scripts\\run-benchmark-spec-settings\.js/u);
  assert.doesNotMatch(String(pkg.scripts?.['benchmark:spec-settings'] || ''), /&&/u);
});

test('package build command syncs dist runtime output after compiling TypeScript', () => {
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8')) as { scripts?: Record<string, string> };

  assert.match(String(pkg.scripts?.build || ''), /node\s+\.\\scripts\\sync-dist-runtime\.js/u);
});

test('syncDistRuntime copies fresh compiled files from dist/src into runtime dist paths', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-dist-runtime-'));
  const sourceRoot = path.join(tempRoot, 'dist', 'src');
  const targetRoot = path.join(tempRoot, 'dist');

  fs.mkdirSync(path.join(sourceRoot, 'status-server'), { recursive: true });
  fs.mkdirSync(path.join(targetRoot, 'status-server'), { recursive: true });
  fs.writeFileSync(path.join(sourceRoot, 'status-server', 'dashboard-runs.js'), 'fresh');
  fs.writeFileSync(path.join(targetRoot, 'status-server', 'dashboard-runs.js'), 'stale');

  syncDistRuntime(sourceRoot, targetRoot);

  assert.equal(fs.readFileSync(path.join(targetRoot, 'status-server', 'dashboard-runs.js'), 'utf8'), 'fresh');
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
