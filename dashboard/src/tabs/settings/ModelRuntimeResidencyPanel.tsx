import React from 'react';

import { postModelResidencyAction } from '../../api';
import type { InferenceRuntimeStatusResult } from '../../hooks/useInferenceRuntimeStatus';
import type {
  InferenceBackendId,
  InferenceModelState,
  InferenceProcessState,
  ModelLifecycleAction,
} from '@siftkit/contracts';

type ResidencyControlState = {
  load: boolean;
  freeze: boolean;
  unload: boolean;
};

export function resolveResidencyControlState(
  modelState: InferenceModelState,
  backend: InferenceBackendId,
  freezeSupported: boolean,
  processState: InferenceProcessState = 'ready',
  requestBusy = false,
): ResidencyControlState {
  const stableProcess = processState === 'ready';
  const stableModel = modelState === 'unloaded' || modelState === 'ready' || modelState === 'frozen';
  if (requestBusy || !stableProcess || !stableModel) {
    return { load: false, freeze: false, unload: false };
  }
  return {
    load: modelState === 'unloaded' || modelState === 'frozen',
    freeze: modelState === 'ready' && backend === 'exl3' && freezeSupported,
    unload: modelState === 'ready' || modelState === 'frozen',
  };
}

function displayValue(value: string | null): string {
  return value ?? '—';
}

type ModelRuntimeResidencyPanelProps = {
  runtime: InferenceRuntimeStatusResult;
};

export function ModelRuntimeResidencyPanel({ runtime }: ModelRuntimeResidencyPanelProps): React.JSX.Element {
  const [actionBusy, setActionBusy] = React.useState(false);
  const [actionError, setActionError] = React.useState<string | null>(null);
  const status = runtime.status;
  const controls = status
    ? resolveResidencyControlState(status.modelState, status.backend, status.freezeSupported, status.processState, actionBusy || runtime.loading || runtime.error !== null)
    : { load: false, freeze: false, unload: false };

  async function runAction(action: ModelLifecycleAction): Promise<void> {
    setActionBusy(true);
    setActionError(null);
    try {
      const result = await postModelResidencyAction(action);
      if (!result.ok) {
        throw new Error(result.error);
      }
      await runtime.refetch();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setActionBusy(false);
    }
  }

  return (
    <section className="settings-live-stack" aria-label="Active model runtime">
      <h3>Active model runtime</h3>
      {runtime.loading && !status ? <p className="hint" role="status">Loading runtime status…</p> : null}
      {runtime.error ? <p className="hint" role="alert">Runtime status error: {runtime.error}</p> : null}
      {status ? (
        <>
          <dl className="fgrid">
            <div className="field"><dt>Active preset</dt><dd className="val">{status.activePresetLabel}</dd></div>
            <div className="field"><dt>Preset id</dt><dd className="val">{status.activePresetId}</dd></div>
            <div className="field"><dt>Backend</dt><dd className="val">{status.backend}</dd></div>
            <div className="field"><dt>Process state</dt><dd className="val">{status.processState}</dd></div>
            <div className="field"><dt>Model state</dt><dd className="val">{status.modelState}</dd></div>
            <div className="field"><dt>Active model</dt><dd className="val">{displayValue(status.model)}</dd></div>
            <div className="field"><dt>Configured idle action</dt><dd className="val">{status.idleAction}</dd></div>
            <div className="field"><dt>Idle deadline</dt><dd className="val">{displayValue(status.idleDeadlineUtc)}</dd></div>
          </dl>
          {status.errorPhase || status.error || status.rollback ? (
            <p className="hint" role="alert">
              {status.errorPhase ? `Transition: ${status.errorPhase}. ` : ''}
              {status.error ? `Error: ${status.error}. ` : ''}
              {status.rollback ? `Rollback: ${status.rollback}` : ''}
            </p>
          ) : null}
          <div className="settings-live-nav-control">
            <button type="button" disabled={!controls.load} onClick={() => { void runAction('load'); }}>Load/Restore</button>
            <button type="button" disabled={!controls.freeze} onClick={() => { void runAction('freeze'); }}>Freeze to RAM</button>
            <button type="button" disabled={!controls.unload} onClick={() => { void runAction('unload'); }}>Unload</button>
          </div>
          {status.backend === 'exl3' && !status.freezeSupported ? (
            <p className="hint" role="status">
              Freeze to RAM is unavailable: the installed exllamav3 has no host-RAM freeze support.
            </p>
          ) : null}
          {actionError ? <p className="hint" role="alert">Runtime action failed: {actionError}</p> : null}
        </>
      ) : null}
    </section>
  );
}
