import React from 'react';
import type {
  AssistantFactoryResetPreview,
  AssistantRestorePreviewResponse,
  AssistantRestoreResult,
} from '../../types.js';
import {
  backupAssistant,
  confirmAssistantFactoryReset,
  confirmAssistantRestore,
  exportAssistant,
  previewAssistantFactoryReset,
  previewAssistantRestore,
} from '../../assistant-api.js';
import { SettingsSectionField } from '../../settings/SettingsFields';

/** Typed verbatim before a factory reset can run (spec §16.5). Compared exactly, never trimmed. */
const RESET_PHRASE = 'RESET ASSISTANT';

/**
 * The archive lives in an object URL for exactly one click. Revoking in the same turn is what
 * keeps a decrypted export out of the page after the download starts.
 */
function downloadArchive(blob: Blob, fileName: string): void {
  const url = window.URL.createObjectURL(blob);
  const anchor = window.document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  window.URL.revokeObjectURL(url);
}

function archiveName(prefix: string): string {
  return `siftkit-assistant-${prefix}-${new Date().toISOString().slice(0, 10)}.zip`;
}

export function AssistantMaintenance(props: { token: string | null }) {
  const [error, setError] = React.useState<string | null>(null);
  const [includeBlobs, setIncludeBlobs] = React.useState(false);
  const [restorePreview, setRestorePreview] =
    React.useState<AssistantRestorePreviewResponse | null>(null);
  const [restoreResult, setRestoreResult] = React.useState<AssistantRestoreResult | null>(null);
  const [resetPreview, setResetPreview] = React.useState<AssistantFactoryResetPreview | null>(null);
  const [resetDone, setResetDone] = React.useState(false);
  const [phrase, setPhrase] = React.useState('');
  const token = props.token;

  async function run(action: (value: string) => Promise<void>): Promise<void> {
    if (token === null) return;
    setError(null);
    try {
      await action(token);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  return (
    <section className="assistant-settings-group assistant-maintenance">
      <h3>Maintenance</h3>
      {error ? <p className="error" role="alert">{error}</p> : null}

      <SettingsSectionField sectionId="assistant" label="Export memory">
        <label className="settings-live-toggle-control">
          <input
            type="checkbox"
            aria-label="Include decrypted evidence blobs"
            checked={includeBlobs}
            onChange={(event) => setIncludeBlobs(event.target.checked)}
          />
          Include decrypted evidence blobs
        </label>
        <button
          type="button"
          className="ghost-btn"
          onClick={() => { void run(async (value) => {
            downloadArchive(await exportAssistant(value, includeBlobs), archiveName('export'));
          }); }}
        >
          Export memory
        </button>
      </SettingsSectionField>

      <SettingsSectionField sectionId="assistant" label="Backup">
        <button
          type="button"
          className="ghost-btn"
          onClick={() => { void run(async (value) => {
            downloadArchive(await backupAssistant(value), archiveName('backup'));
          }); }}
        >
          Create backup
        </button>
      </SettingsSectionField>

      <SettingsSectionField sectionId="assistant" label="Restore">
        <input
          type="file"
          accept=".zip,application/zip"
          aria-label="Backup archive to restore"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file === undefined) return;
            void run(async (value) => {
              setRestoreResult(null);
              setRestorePreview(await previewAssistantRestore(value, file));
            });
          }}
        />
        {restorePreview !== null ? (
          <div className="assistant-delete-preview" role="alert">
            <p>
              {restorePreview.fileCount} files · {restorePreview.totalBytes} bytes ·
              schema version {restorePreview.schemaVersion} · {restorePreview.custody} custody
            </p>
            <button
              type="button"
              className="ghost-btn danger"
              onClick={() => { void run(async (value) => {
                const result = await confirmAssistantRestore(
                  value, restorePreview.uploadId, restorePreview.confirmToken,
                );
                setRestorePreview(null);
                setRestoreResult(result);
              }); }}
            >
              Confirm restore
            </button>
          </div>
        ) : null}
        {restoreResult !== null ? (
          <p className={restoreResult.blobsReadable ? 'hint' : 'error'} role="status">
            {restoreResult.warning ?? 'Restore complete; evidence blobs are readable.'}
          </p>
        ) : null}
      </SettingsSectionField>

      <SettingsSectionField sectionId="assistant" label="Factory reset">
        <button
          type="button"
          className="ghost-btn danger"
          onClick={() => { void run(async (value) => {
            setResetDone(false);
            setResetPreview(await previewAssistantFactoryReset(value));
          }); }}
        >
          Preview factory reset
        </button>
        {resetPreview !== null ? (
          <div className="assistant-delete-preview" role="alert">
            <p>
              {Object.values(resetPreview.tableCounts).reduce((total, count) => total + count, 0)}
              {' '}memory rows and {resetPreview.blobCount} evidence blobs
              ({resetPreview.blobBytes} bytes) are erased.
            </p>
          </div>
        ) : null}
        <input
          aria-label="Type RESET ASSISTANT to enable the reset button"
          value={phrase}
          onChange={(event) => setPhrase(event.target.value)}
        />
        <button
          type="button"
          className="ghost-btn danger"
          disabled={phrase !== RESET_PHRASE || resetPreview === null}
          onClick={() => {
            if (resetPreview === null) return;
            const { previewToken } = resetPreview;
            void run(async (value) => {
              await confirmAssistantFactoryReset(value, previewToken);
              setResetPreview(null);
              setPhrase('');
              setResetDone(true);
            });
          }}
        >
          Reset assistant
        </button>
        {resetDone ? <p className="hint" role="status">Assistant memory was erased.</p> : null}
      </SettingsSectionField>
    </section>
  );
}
