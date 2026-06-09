export function getAbortError(abortSignal?: AbortSignal): Error {
  return abortSignal?.reason instanceof Error
    ? abortSignal.reason
    : new Error(String(abortSignal?.reason || 'Repo search aborted.'));
}

export function throwIfAborted(abortSignal?: AbortSignal): void {
  if (abortSignal?.aborted) {
    throw getAbortError(abortSignal);
  }
}
