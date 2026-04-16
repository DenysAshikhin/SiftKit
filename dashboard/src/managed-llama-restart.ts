import type { RestartBackendResponse } from './types';

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
  return {
    title: 'Managed llama.cpp ran out of GPU memory',
    message: `Needed ${response.startupFailure.requiredMiB} MiB of GPU memory, but only ${response.startupFailure.availableMiB} MiB was available.`,
  };
}
