import assert from 'node:assert/strict';
import test from 'node:test';

import { getManagedLlamaConfig, getDefaultConfig } from '../src/status-server/config-store';
import {
  buildManagedLlamaArgs,
  parseManagedLlamaSpeculativeMetricsText,
} from '../src/status-server/managed-llama';

type ManagedPresetRecord = Record<string, unknown>;

function activePreset(config: unknown): ManagedPresetRecord {
  const llama = (config as {
    Server: { LlamaCpp: { Presets: ManagedPresetRecord[]; ActivePresetId: string } };
  }).Server.LlamaCpp;
  return llama.Presets.find((preset) => preset.id === llama.ActivePresetId) ?? llama.Presets[0];
}

function createConfig(ncpuMoe: number): unknown {
  const config = getDefaultConfig();
  const preset = activePreset(config);
  preset.ModelPath = 'D:\\models\\qwen-27b.gguf';
  preset.NcpuMoe = ncpuMoe;
  return config;
}

function createSpeculativeConfig(overrides: Record<string, unknown>): unknown {
  const config = createConfig(0);
  Object.assign(activePreset(config), { SpeculativeEnabled: true }, overrides);
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

function draftCacheArgs(overrides: Record<string, unknown>): string[] {
  const args = buildManagedLlamaArgs(getManagedLlamaConfig(createSpeculativeConfig(overrides)));
  const start = args.indexOf('-ctkd');
  return start === -1 ? [] : args.slice(start, start + 4);
}

test('buildManagedLlamaArgs uses the same KV quant for K and V when KvCacheQuantization is a single value', () => {
  const config = createConfig(0);
  activePreset(config).KvCacheQuantization = 'q8_0';

  const args = buildManagedLlamaArgs(getManagedLlamaConfig(config));
  const kIndex = args.indexOf('--cache-type-k');
  const vIndex = args.indexOf('--cache-type-v');

  assert.deepEqual(args.slice(kIndex, kIndex + 2), ['--cache-type-k', 'q8_0']);
  assert.deepEqual(args.slice(vIndex, vIndex + 2), ['--cache-type-v', 'q8_0']);
});

test('buildManagedLlamaArgs splits K/V composite KvCacheQuantization into independent cache-type flags', () => {
  const config = createConfig(0);
  activePreset(config).KvCacheQuantization = 'q8_0/q4_1';

  const args = buildManagedLlamaArgs(getManagedLlamaConfig(config));
  const kIndex = args.indexOf('--cache-type-k');
  const vIndex = args.indexOf('--cache-type-v');

  assert.deepEqual(args.slice(kIndex, kIndex + 2), ['--cache-type-k', 'q8_0']);
  assert.deepEqual(args.slice(vIndex, vIndex + 2), ['--cache-type-v', 'q4_1']);
});

test('buildManagedLlamaArgs omits --n-cpu-moe when NcpuMoe is 0', () => {
  const args = buildManagedLlamaArgs(getManagedLlamaConfig(createConfig(0)));

  assert.equal(args.includes('--n-cpu-moe'), false);
});

test('getDefaultConfig disables NcpuMoe by default', () => {
  const preset = activePreset(getDefaultConfig());

  assert.equal(preset.NcpuMoe, 0);
  assert.equal(preset.SpeculativeEnabled, false);
  assert.equal(preset.SleepIdleSeconds, 600);
});

test('buildManagedLlamaArgs enables llama-server sleep idle by default', () => {
  const args = buildManagedLlamaArgs(getManagedLlamaConfig(createConfig(0)));

  assert.deepEqual(args.slice(args.indexOf('--sleep-idle-seconds'), args.indexOf('--sleep-idle-seconds') + 2), [
    '--sleep-idle-seconds', '600',
  ]);
});

test('buildManagedLlamaArgs uses the configured sleep idle seconds', () => {
  const config = createConfig(0);
  activePreset(config).SleepIdleSeconds = 120;

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
  const preset = activePreset(getDefaultConfig());

  assert.equal(preset.SpeculativeMtpEnabled, false);
  assert.equal(preset.SpeculativeNgramModNMatch, 24);
  assert.equal(preset.SpeculativeNgramModNMin, 4);
  assert.equal(preset.SpeculativeNgramModNMax, 16);
});

test('buildManagedLlamaArgs omits speculative flags when speculative decoding is disabled', () => {
  const config = createConfig(0);
  activePreset(config).SpeculativeEnabled = false;

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
    '-ctkd', 'q8_0',
    '-ctvd', 'q8_0',
    '--spec-draft-n-max', '3',
    '--spec-draft-n-min', '1',
  ]);
  assert.equal(args.includes('--spec-ngram-mod-n-match'), false);
});

test('buildManagedLlamaArgs emits q8_0 draft cache flags for draft-mtp speculation', () => {
  const args = draftCacheArgs({
    SpeculativeType: 'draft-mtp',
  });

  assert.deepEqual(args, ['-ctkd', 'q8_0', '-ctvd', 'q8_0']);
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
    '-ctkd', 'q8_0',
    '-ctvd', 'q8_0',
    '--spec-draft-n-max', '3',
    '--spec-ngram-mod-n-match', '24',
    '--spec-ngram-mod-n-min', '12',
    '--spec-ngram-mod-n-max', '48',
  ]);
});

test('buildManagedLlamaArgs emits q8_0 draft cache flags for combined MTP speculation', () => {
  const args = draftCacheArgs({
    SpeculativeType: 'ngram-mod',
    SpeculativeMtpEnabled: true,
  });

  assert.deepEqual(args, ['-ctkd', 'q8_0', '-ctvd', 'q8_0']);
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

  assert.deepEqual(args, ['--spec-type', 'draft-mtp', '-ctkd', 'q8_0', '-ctvd', 'q8_0', '--spec-draft-n-max', '5']);
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
