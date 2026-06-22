import React from 'react';
import { RUN_LOG_TYPE_PRESETS } from '../run-log-admin';
import type { RunDeleteController } from '../hooks/useRunsController';

export function RunDeleteModal({ runDelete }: { runDelete: RunDeleteController }) {
  return (
    <section className="settings-live-modal-backdrop" role="presentation">
      <div className="run-delete-modal" role="dialog" aria-modal="true" aria-labelledby="run-delete-title">
        <div className="run-delete-header">
          <div>
            <h2 id="run-delete-title">Delete logs</h2>
            <p className="hint">Preview the matching logs first, then permanently remove them from the dashboard database.</p>
          </div>
          <button type="button" className="run-delete-close" onClick={runDelete.close} disabled={runDelete.busy} aria-label="Close delete logs dialog">
            x
          </button>
        </div>

        <div className="run-delete-mode-row">
          <button
            type="button"
            className={runDelete.mode === 'count' ? 'active' : ''}
            onClick={() => runDelete.setMode('count')}
            disabled={runDelete.busy}
          >
            Delete Oldest N
          </button>
          <button
            type="button"
            className={runDelete.mode === 'before_date' ? 'active' : ''}
            onClick={() => runDelete.setMode('before_date')}
            disabled={runDelete.busy}
          >
            Delete Before Date
          </button>
        </div>

        <div className="filter-pill-row">
          <span className="filter-pill-label">Type</span>
          {RUN_LOG_TYPE_PRESETS.map((preset) => (
            <button
              key={preset.deleteValue}
              type="button"
              className={`filter-pill kind ${preset.tone} ${runDelete.type === preset.deleteValue ? 'active' : ''}`}
              onClick={() => runDelete.setType(preset.deleteValue)}
              disabled={runDelete.busy}
            >
              {preset.label}
            </button>
          ))}
        </div>

        <div className="run-delete-fields">
          {runDelete.mode === 'count' ? (
            <label>
              <span>Delete oldest matching logs</span>
              <input
                type="number"
                min="1"
                step="1"
                value={runDelete.countInput}
                onChange={(event) => runDelete.setCountInput(event.target.value)}
                disabled={runDelete.busy}
              />
            </label>
          ) : (
            <label>
              <span>Delete logs older than</span>
              <input
                type="date"
                value={runDelete.beforeDate}
                onChange={(event) => runDelete.setBeforeDate(event.target.value)}
                disabled={runDelete.busy}
              />
            </label>
          )}
        </div>

        <div className={`run-delete-preview ${runDelete.previewCount === 0 ? 'empty' : 'ready'}`}>
          <strong>{runDelete.summary || 'Choose valid delete criteria'}</strong>
          <span className="hint">
            {runDelete.previewBusy
              ? 'Checking matching logs...'
              : runDelete.hasCriteria && runDelete.previewCount !== null
                ? `${runDelete.previewCount} matching ${runDelete.previewCount === 1 ? 'log' : 'logs'} found.`
                : 'Enter a count or date to preview the delete scope.'}
          </span>
        </div>

        {runDelete.error && <p className="error">{runDelete.error}</p>}

        <div className="run-delete-modal-actions">
          <button type="button" onClick={runDelete.close} disabled={runDelete.busy}>
            Cancel
          </button>
          <button
            type="button"
            className="danger-button"
            onClick={() => { void runDelete.confirm(); }}
            disabled={runDelete.busy || runDelete.previewBusy || !runDelete.hasCriteria || runDelete.previewCount === null || runDelete.previewCount < 1}
          >
            {runDelete.busy ? 'Deleting...' : runDelete.summary || 'Delete Logs'}
          </button>
        </div>
      </div>
    </section>
  );
}
