import assert from 'node:assert/strict';
import test from 'node:test';

import { buildManagedLlamaRestartFailureModal } from '../dashboard/src/managed-llama-restart.ts';

test('buildManagedLlamaRestartFailureModal formats GPU OOM memory details', () => {
  assert.deepEqual(
    buildManagedLlamaRestartFailureModal({
      ok: false,
      restarted: false,
      error: 'cudaMalloc failed: out of memory',
      startupFailure: {
        kind: 'gpu_memory_oom',
        requiredMiB: 25293,
        availableMiB: 22842,
      },
    }),
    {
      title: 'Managed llama.cpp ran out of GPU memory',
      message: 'Needed 25293 MiB of GPU memory, but only 22842 MiB was available.',
    },
  );
});
