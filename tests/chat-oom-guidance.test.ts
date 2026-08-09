import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ManagedLlamaStartupError,
} from '../src/status-server/managed-llama.js';
import { formatChatEngineError } from '../src/status-server/routes/chat.js';

const IMAGE = ['data:image/png;base64,AAAA'];

test('route formatter keeps typed startup OOM guidance on the startup knob', () => {
  const error = new ManagedLlamaStartupError(
    'Managed llama.cpp ran out of GPU memory during startup.',
    { kind: 'gpu_memory_oom', requiredMiB: 24_000, availableMiB: 800 },
  );

  const message = formatChatEngineError(error, IMAGE, 2_097_152);

  assert.match(message, /context length|CacheRam/u);
  assert.doesNotMatch(message, /Max image size|VisionMaxImagePixels/u);
});

test('route formatter uses image-size guidance for a generic OOM on an image request', () => {
  const message = formatChatEngineError(
    'torch.cuda.OutOfMemoryError: CUDA out of memory.',
    IMAGE,
    2_097_152,
  );

  assert.match(message, /Max image size/u);
  assert.match(message, /2\.1 MP/u);
});

test('route formatter leaves a text-only generic OOM unchanged', () => {
  const error = 'torch.cuda.OutOfMemoryError: CUDA out of memory.';
  assert.equal(formatChatEngineError(error, [], 2_097_152), error);
});
