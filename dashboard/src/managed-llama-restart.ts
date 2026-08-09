import type { RestartBackendResponse } from './types.js';

export type ManagedLlamaRestartFailureModal = {
  title: string;
  message: string;
};

export function buildManagedLlamaRestartFailureModal(
  response: RestartBackendResponse,
): ManagedLlamaRestartFailureModal | null {
  if (response.startupFailure?.kind !== 'gpu_memory_oom') {
    return null;
  }
  const requiredMiB = response.startupFailure.requiredMiB ?? 'unknown';
  const availableMiB = response.startupFailure.availableMiB ?? 'unknown';
  return {
    title: 'Managed llama.cpp ran out of GPU memory',
    message: `Needed ${requiredMiB} MiB of GPU memory, but only ${availableMiB} MiB was available.`,
  };
}
