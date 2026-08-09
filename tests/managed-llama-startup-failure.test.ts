import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildGpuOomGuidance,
  parseManagedLlamaStartupFailureText,
} from '../src/status-server/managed-llama.js';

const TORCH_OOM = 'torch.cuda.OutOfMemoryError: CUDA out of memory. Tried to allocate 2.00 GiB. '
  + 'GPU 0 has a total capacity of 23.99 GiB of which 812.00 MiB is free.';

test('a PyTorch/exl3 OOM is recognised', () => {
  const failure = parseManagedLlamaStartupFailureText(TORCH_OOM);
  assert.equal(failure?.kind, 'gpu_memory_oom');
});

test('a bare OOM with no projected-memory line is still recognised, with unknown numbers', () => {
  const failure = parseManagedLlamaStartupFailureText('cudaMalloc failed: out of memory');

  assert.equal(failure?.kind, 'gpu_memory_oom');
  assert.equal(failure?.requiredMiB, null);
  assert.equal(failure?.availableMiB, null);
});

test('the llama.cpp form still reports both numbers', () => {
  const failure = parseManagedLlamaStartupFailureText(
    'projected to use 24000 MiB of device memory vs. 800 MiB of free device memory\n'
      + 'cannot meet free memory target',
  );

  assert.equal(failure?.requiredMiB, 24_000);
  assert.equal(failure?.availableMiB, 800);
});

test('unrelated error text is not an OOM', () => {
  assert.equal(parseManagedLlamaStartupFailureText('error: model file not found'), null);
});

test('a STARTUP oom never names the image size setting', () => {
  const message = buildGpuOomGuidance({
    phase: 'startup',
    failure: { kind: 'gpu_memory_oom', requiredMiB: 24_000, availableMiB: 800 },
  });

  assert.match(message, /context length|CacheRam/u);
  assert.doesNotMatch(message, /Max image size|VisionMaxImagePixels/u);
});

test('an IMAGE-ENCODE oom names the image size setting and its current value', () => {
  const message = buildGpuOomGuidance({
    phase: 'image_encode',
    failure: { kind: 'gpu_memory_oom', requiredMiB: null, availableMiB: null },
    visionMaxImagePixels: 2_097_152,
  });

  assert.match(message, /Max image size/u);
  assert.match(message, /2\.1 MP/u);
  assert.doesNotMatch(message, /context length/u);
});
