import assert from 'node:assert/strict';
import test from 'node:test';

import { getManagedLlamaConfig, getDefaultConfig } from '../src/status-server/config-store';
import {
  buildManagedLlamaArgs,
  parseManagedLlamaSpeculativeMetricsText,
} from '../src/status-server/managed-llama';

function createConfig(ncpuMoe: number): unknown {
  const config = getDefaultConfig() as {
    Server: {
      LlamaCpp: {
        ModelPath: string | null;
        NcpuMoe?: number;
        SpeculativeEnabled?: boolean;
        SpeculativeType?: string;
        SpeculativeNgramSizeN?: number;
        SpeculativeNgramSizeM?: number;
        SpeculativeNgramMinHits?: number;
        SpeculativeDraftMax?: number;
        SpeculativeDraftMin?: number;
      };
    };
  };
  config.Server.LlamaCpp.ModelPath = 'D:\\models\\qwen-27b.gguf';
  config.Server.LlamaCpp.NcpuMoe = ncpuMoe;
  return config;
}

test('buildManagedLlamaArgs omits --n-cpu-moe when NcpuMoe is 0', () => {
  const args = buildManagedLlamaArgs(getManagedLlamaConfig(createConfig(0)));

  assert.equal(args.includes('--n-cpu-moe'), false);
});

test('getDefaultConfig disables NcpuMoe by default', () => {
  const config = getDefaultConfig() as {
    Server: {
      LlamaCpp: {
        NcpuMoe?: number;
        SpeculativeEnabled?: boolean;
      };
    };
  };

  assert.equal(config.Server.LlamaCpp.NcpuMoe, 0);
  assert.equal(config.Server.LlamaCpp.SpeculativeEnabled, false);
});

test('buildManagedLlamaArgs includes --n-cpu-moe when NcpuMoe is non-zero', () => {
  const args = buildManagedLlamaArgs(getManagedLlamaConfig(createConfig(8)));

  assert.deepEqual(args.slice(args.indexOf('--n-cpu-moe'), args.indexOf('--n-cpu-moe') + 2), ['--n-cpu-moe', '8']);
});

test('buildManagedLlamaArgs omits speculative flags when speculative decoding is disabled', () => {
  const config = createConfig(0) as {
    Server: {
      LlamaCpp: {
        SpeculativeEnabled?: boolean;
      };
    };
  };
  config.Server.LlamaCpp.SpeculativeEnabled = false;

  const args = buildManagedLlamaArgs(getManagedLlamaConfig(config));

  assert.equal(args.includes('--spec-type'), false);
});

test('buildManagedLlamaArgs includes ngram speculative flags when enabled', () => {
  const config = createConfig(0) as {
    Server: {
      LlamaCpp: {
        SpeculativeEnabled?: boolean;
        SpeculativeType?: string;
        SpeculativeNgramSizeN?: number;
        SpeculativeNgramSizeM?: number;
        SpeculativeNgramMinHits?: number;
        SpeculativeDraftMax?: number;
        SpeculativeDraftMin?: number;
      };
    };
  };
  Object.assign(config.Server.LlamaCpp, {
    SpeculativeEnabled: true,
    SpeculativeType: 'ngram-map-k',
    SpeculativeNgramSizeN: 8,
    SpeculativeNgramSizeM: 16,
    SpeculativeNgramMinHits: 2,
    SpeculativeDraftMax: 16,
    SpeculativeDraftMin: 4,
  });

  const args = buildManagedLlamaArgs(getManagedLlamaConfig(config));
  const speculativeIndex = args.indexOf('--spec-type');

  assert.notEqual(speculativeIndex, -1);
  assert.deepEqual(args.slice(speculativeIndex, speculativeIndex + 12), [
    '--spec-type', 'ngram-map-k',
    '--spec-ngram-size-n', '8',
    '--spec-ngram-size-m', '16',
    '--spec-ngram-min-hits', '2',
    '--draft-max', '16',
    '--draft-min', '4',
  ]);
});

test('buildManagedLlamaArgs omits speculative numeric flags set to -1', () => {
  const config = createConfig(0) as {
    Server: {
      LlamaCpp: {
        SpeculativeEnabled?: boolean;
        SpeculativeType?: string;
        SpeculativeNgramSizeN?: number;
        SpeculativeNgramSizeM?: number;
        SpeculativeNgramMinHits?: number;
        SpeculativeDraftMax?: number;
        SpeculativeDraftMin?: number;
      };
    };
  };
  Object.assign(config.Server.LlamaCpp, {
    SpeculativeEnabled: true,
    SpeculativeType: 'ngram-mod',
    SpeculativeNgramSizeN: 24,
    SpeculativeNgramSizeM: -1,
    SpeculativeNgramMinHits: -1,
    SpeculativeDraftMax: 48,
    SpeculativeDraftMin: 12,
  });

  const managed = getManagedLlamaConfig(config);
  const args = buildManagedLlamaArgs(managed);

  assert.equal(managed.SpeculativeNgramSizeM, -1);
  assert.equal(managed.SpeculativeNgramMinHits, -1);
  assert.deepEqual(args.slice(args.indexOf('--spec-type'), args.indexOf('--spec-type') + 8), [
    '--spec-type', 'ngram-mod',
    '--spec-ngram-size-n', '24',
    '--draft-max', '48',
    '--draft-min', '12',
  ]);
  assert.equal(args.includes('--spec-ngram-size-m'), false);
  assert.equal(args.includes('--spec-ngram-min-hits'), false);
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
