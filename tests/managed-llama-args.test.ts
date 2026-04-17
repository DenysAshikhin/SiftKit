import assert from 'node:assert/strict';
import test from 'node:test';

import { getManagedLlamaConfig, getDefaultConfig } from '../src/status-server/config-store';
import { buildManagedLlamaArgs } from '../src/status-server/managed-llama';

function createConfig(ncpuMoe: number): unknown {
  const config = getDefaultConfig() as {
    Server: {
      LlamaCpp: {
        ModelPath: string | null;
        NcpuMoe?: number;
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
      };
    };
  };

  assert.equal(config.Server.LlamaCpp.NcpuMoe, 0);
});

test('buildManagedLlamaArgs includes --n-cpu-moe when NcpuMoe is non-zero', () => {
  const args = buildManagedLlamaArgs(getManagedLlamaConfig(createConfig(8)));

  assert.deepEqual(args.slice(args.indexOf('--n-cpu-moe'), args.indexOf('--n-cpu-moe') + 2), ['--n-cpu-moe', '8']);
});
