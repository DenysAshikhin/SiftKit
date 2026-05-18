import assert from 'node:assert/strict';
import test from 'node:test';

import { getManagedLlamaConfig, getDefaultConfig } from '../src/status-server/config-store';
import {
  buildManagedLlamaArgs,
  parseManagedLlamaSpeculativeMetricsText,
} from '../src/status-server/managed-llama';

function createConfig(ncpuMoe: number): unknown {
  const config = getDefaultConfig() as {
    Server: { LlamaCpp: { ModelPath: string | null; NcpuMoe?: number } };
  };
  config.Server.LlamaCpp.ModelPath = 'D:\\models\\qwen-27b.gguf';
  config.Server.LlamaCpp.NcpuMoe = ncpuMoe;
  return config;
}

function createSpeculativeConfig(overrides: Record<string, unknown>): unknown {
  const config = createConfig(0) as { Server: { LlamaCpp: Record<string, unknown> } };
  Object.assign(config.Server.LlamaCpp, { SpeculativeEnabled: true }, overrides);
  return config;
}

// Returns just the speculative-decoding flags: from `--spec-type` up to the
// trailing `-fa` flag that buildManagedLlamaArgs always appends afterwards.
function speculativeArgs(overrides: Record<string, unknown>): string[] {
  const args = buildManagedLlamaArgs(getManagedLlamaConfig(createSpeculativeConfig(overrides)));
  const start = args.indexOf('--spec-type');
  const end = args.indexOf('-fa', start);
  return args.slice(start, end === -1 ? undefined : end);
}

test('buildManagedLlamaArgs omits --n-cpu-moe when NcpuMoe is 0', () => {
  const args = buildManagedLlamaArgs(getManagedLlamaConfig(createConfig(0)));

  assert.equal(args.includes('--n-cpu-moe'), false);
});

test('getDefaultConfig disables NcpuMoe by default', () => {
  const config = getDefaultConfig() as {
    Server: { LlamaCpp: { NcpuMoe?: number; SpeculativeEnabled?: boolean; SleepIdleSeconds?: number } };
  };

  assert.equal(config.Server.LlamaCpp.NcpuMoe, 0);
  assert.equal(config.Server.LlamaCpp.SpeculativeEnabled, false);
  assert.equal(config.Server.LlamaCpp.SleepIdleSeconds, 600);
});

test('buildManagedLlamaArgs enables llama-server sleep idle by default', () => {
  const args = buildManagedLlamaArgs(getManagedLlamaConfig(createConfig(0)));

  assert.deepEqual(args.slice(args.indexOf('--sleep-idle-seconds'), args.indexOf('--sleep-idle-seconds') + 2), [
    '--sleep-idle-seconds', '600',
  ]);
});

test('buildManagedLlamaArgs uses the configured sleep idle seconds', () => {
  const config = createConfig(0) as { Server: { LlamaCpp: { SleepIdleSeconds?: number } } };
  config.Server.LlamaCpp.SleepIdleSeconds = 120;

  const args = buildManagedLlamaArgs(getManagedLlamaConfig(config));

  assert.deepEqual(args.slice(args.indexOf('--sleep-idle-seconds'), args.indexOf('--sleep-idle-seconds') + 2), [
    '--sleep-idle-seconds', '120',
  ]);
});

test('buildManagedLlamaArgs includes --n-cpu-moe when NcpuMoe is non-zero', () => {
  const args = buildManagedLlamaArgs(getManagedLlamaConfig(createConfig(8)));

  assert.deepEqual(args.slice(args.indexOf('--n-cpu-moe'), args.indexOf('--n-cpu-moe') + 2), ['--n-cpu-moe', '8']);
});

test('getDefaultConfig disables MTP combination and seeds ngram-mod defaults', () => {
  const config = getDefaultConfig() as {
    Server: {
      LlamaCpp: {
        SpeculativeMtpEnabled?: boolean;
        SpeculativeNgramModNMatch?: number;
        SpeculativeNgramModNMin?: number;
        SpeculativeNgramModNMax?: number;
      };
    };
  };

  assert.equal(config.Server.LlamaCpp.SpeculativeMtpEnabled, false);
  assert.equal(config.Server.LlamaCpp.SpeculativeNgramModNMatch, 24);
  assert.equal(config.Server.LlamaCpp.SpeculativeNgramModNMin, 4);
  assert.equal(config.Server.LlamaCpp.SpeculativeNgramModNMax, 16);
});

test('buildManagedLlamaArgs omits speculative flags when speculative decoding is disabled', () => {
  const config = createConfig(0) as { Server: { LlamaCpp: { SpeculativeEnabled?: boolean } } };
  config.Server.LlamaCpp.SpeculativeEnabled = false;

  const args = buildManagedLlamaArgs(getManagedLlamaConfig(config));

  assert.equal(args.includes('--spec-type'), false);
});

test('buildManagedLlamaArgs emits per-type size flags for ngram-map-k speculation', () => {
  const args = speculativeArgs({
    SpeculativeType: 'ngram-map-k',
    SpeculativeNgramSizeN: 8,
    SpeculativeNgramSizeM: 16,
    SpeculativeNgramMinHits: 2,
  });

  assert.deepEqual(args, [
    '--spec-type', 'ngram-map-k',
    '--spec-ngram-map-k-size-n', '8',
    '--spec-ngram-map-k-size-m', '16',
    '--spec-ngram-map-k-min-hits', '2',
  ]);
});

test('buildManagedLlamaArgs emits ngram-mod n-match/n-min/n-max flags for ngram-mod speculation', () => {
  const args = speculativeArgs({
    SpeculativeType: 'ngram-mod',
    SpeculativeNgramModNMatch: 24,
    SpeculativeNgramModNMin: 12,
    SpeculativeNgramModNMax: 48,
  });

  assert.deepEqual(args, [
    '--spec-type', 'ngram-mod',
    '--spec-ngram-mod-n-match', '24',
    '--spec-ngram-mod-n-min', '12',
    '--spec-ngram-mod-n-max', '48',
  ]);
});

test('buildManagedLlamaArgs omits ngram-mod numeric flags set to -1', () => {
  const args = speculativeArgs({
    SpeculativeType: 'ngram-mod',
    SpeculativeNgramModNMatch: 24,
    SpeculativeNgramModNMin: -1,
    SpeculativeNgramModNMax: -1,
  });

  assert.deepEqual(args, ['--spec-type', 'ngram-mod', '--spec-ngram-mod-n-match', '24']);
});

test('buildManagedLlamaArgs emits draft-token flags for draft-mtp speculation', () => {
  const args = speculativeArgs({
    SpeculativeType: 'draft-mtp',
    SpeculativeDraftMax: 3,
    SpeculativeDraftMin: 1,
  });

  assert.deepEqual(args, [
    '--spec-type', 'draft-mtp',
    '--spec-draft-n-max', '3',
    '--spec-draft-n-min', '1',
  ]);
  assert.equal(args.includes('--spec-ngram-mod-n-match'), false);
});

test('buildManagedLlamaArgs chains draft-mtp into a comma-separated --spec-type when MTP combination is enabled', () => {
  const args = speculativeArgs({
    SpeculativeType: 'ngram-mod',
    SpeculativeMtpEnabled: true,
    SpeculativeDraftMax: 3,
    SpeculativeDraftMin: -1,
    SpeculativeNgramModNMatch: 24,
    SpeculativeNgramModNMin: 12,
    SpeculativeNgramModNMax: 48,
  });

  assert.deepEqual(args, [
    '--spec-type', 'draft-mtp,ngram-mod',
    '--spec-draft-n-max', '3',
    '--spec-ngram-mod-n-match', '24',
    '--spec-ngram-mod-n-min', '12',
    '--spec-ngram-mod-n-max', '48',
  ]);
});

test('buildManagedLlamaArgs omits the chained draft-mtp when MTP combination is disabled', () => {
  const args = speculativeArgs({
    SpeculativeType: 'ngram-mod',
    SpeculativeMtpEnabled: false,
    SpeculativeNgramModNMatch: 24,
  });

  assert.deepEqual(args.slice(0, 2), ['--spec-type', 'ngram-mod']);
  assert.equal(args.includes('--spec-draft-n-max'), false);
});

test('buildManagedLlamaArgs does not duplicate draft-mtp when the primary type is draft-mtp', () => {
  const args = speculativeArgs({
    SpeculativeType: 'draft-mtp',
    SpeculativeMtpEnabled: true,
    SpeculativeDraftMax: 5,
    SpeculativeDraftMin: -1,
  });

  assert.deepEqual(args, ['--spec-type', 'draft-mtp', '--spec-draft-n-max', '5']);
});

test('parseManagedLlamaSpeculativeMetricsText extracts accepted and generated token totals from ngram statistics', () => {
  const parsed = parseManagedLlamaSpeculativeMetricsText([
    'llama_decode: statistics ngram_map_k: #draft tokens = 21, #gen tokens = 18, #acc tokens = 12, #res tokens = 6',
    'llama_decode: draft acceptance rate = 66.67% (12 / 18)',
  ].join('\n'));

  assert.deepEqual(parsed, {
    speculativeAcceptedTokens: 12,
    speculativeGeneratedTokens: 18,
  });
});

test('parseManagedLlamaSpeculativeMetricsText returns null when speculative totals are absent', () => {
  const parsed = parseManagedLlamaSpeculativeMetricsText('llama server ready\nslot update_slots: id 0 | task 42 | stop processing\n');

  assert.equal(parsed, null);
});

test('parseManagedLlamaSpeculativeMetricsText ignores echoed request text that mentions speculative regex patterns', () => {
  const parsed = parseManagedLlamaSpeculativeMetricsText([
    'srv  log_server_r: request:  {"content":"const MANAGED_LLAMA_SPECULATIVE_STATS_PATTERN = /#gen tokens\\\\s*=\\\\s*(\\\\d+).+?#acc tokens\\\\s*=\\\\s*(\\\\d+)/iu;"}',
    'srv  log_server_r: request:  {"content":"const MANAGED_LLAMA_SPECULATIVE_RATE_PATTERN = /draft acceptance rate\\\\s*=\\\\s*[^ (]+\\\\(\\\\s*(\\\\d+)\\\\s*\\\\/\\\\s*(\\\\d+)\\\\s*\\\\)/iu;"}',
    'srv  update_chat_: Parsing chat message: draft acceptance rate = 0.00% (0 / 0)',
    'llama server ready',
  ].join('\n'));

  assert.equal(parsed, null);
});

test('parseManagedLlamaSpeculativeMetricsText ignores echoed multiline request content that mentions acceptance lines without llama_decode prefix', () => {
  const parsed = parseManagedLlamaSpeculativeMetricsText([
    'srv  log_server_r: request:  {"content":"Context',
    'draft acceptance rate = 0.00% (0 / 0)',
    '#gen tokens = 18, #acc tokens = 12',
    'still user text"}',
    'srv  log_server_r: done request: POST /completion 127.0.0.1 200',
  ].join('\n'));

  assert.equal(parsed, null);
});

test('parseManagedLlamaSpeculativeMetricsText extracts totals from checkpointed speculative logs without llama_decode prefix', () => {
  const parsed = parseManagedLlamaSpeculativeMetricsText([
    'draft acceptance rate = 1.00000 (    8 accepted /     8 generated)',
    'draft acceptance rate = 1.00000 (    4 accepted /     4 generated)',
    'statistics ngram_mod: #calls(b,g,a) = 20 2985 131, #gen drafts = 131, #acc drafts = 131, #gen tokens = 6168, #acc tokens = 5837',
  ].join('\n'));

  assert.deepEqual(parsed, {
    speculativeAcceptedTokens: 5837,
    speculativeGeneratedTokens: 6168,
  });
});

test('parseManagedLlamaSpeculativeMetricsText ignores draft acceptance rate lines without statistics totals', () => {
  const parsed = parseManagedLlamaSpeculativeMetricsText([
    'draft acceptance rate = 1.00000 (    8 accepted /     8 generated)',
    'draft acceptance rate = 1.00000 (    4 accepted /     4 generated)',
  ].join('\n'));

  assert.equal(parsed, null);
});
