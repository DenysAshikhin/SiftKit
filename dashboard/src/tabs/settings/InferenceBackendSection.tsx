import React from 'react';
import type { BackendRuntimeStatus, InferenceBackendId } from '@siftkit/contracts';
import { getBackendRuntimeStatus, updateBackendRuntime } from '../../api';

function statusText(status: BackendRuntimeStatus): string {
  const pending = status.pending ? `; pending ${status.pending}` : '';
  return `Active ${status.active ?? 'none'}; selected ${status.selected}; ${status.state}${pending}`;
}

export function InferenceBackendSection() {
  const [status, setStatus] = React.useState<BackendRuntimeStatus | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    const refresh = async (): Promise<void> => {
      try {
        const next = await getBackendRuntimeStatus();
        if (!cancelled) {
          setStatus(next);
          setError(null);
        }
      } catch (refreshError) {
        if (!cancelled) {
          setError(refreshError instanceof Error ? refreshError.message : String(refreshError));
        }
      }
    };
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 2000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const selectBackend = async (backend: InferenceBackendId): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const response = await updateBackendRuntime(backend);
      setStatus(response.status);
    } catch (selectionError) {
      setError(selectionError instanceof Error ? selectionError.message : String(selectionError));
    } finally {
      setBusy(false);
    }
  };

  const transitionLocked = status?.state === 'starting' || status?.state === 'stopping';
  return (
    <div className="inference-backend-section">
      <div className="settings-live-nav-control">
        <select
          aria-label="Inference backend"
          value={status?.selected ?? 'llama'}
          disabled={busy || transitionLocked}
          onChange={(event) => { void selectBackend(event.target.value === 'exl3' ? 'exl3' : 'llama'); }}
        >
          <option value="llama">llama.cpp</option>
          <option value="exl3">TabbyAPI / EXL3</option>
        </select>
        <span className="hint">{status ? statusText(status) : 'Loading runtime status...'}</span>
      </div>
      {status?.model && <span className="hint">Model: {status.model}</span>}
      {(error || status?.error) && <span className="settings-live-warning">{error ?? status?.error}</span>}
      {status?.rollback && <span className="hint">Rollback: {status.rollback}</span>}
    </div>
  );
}
