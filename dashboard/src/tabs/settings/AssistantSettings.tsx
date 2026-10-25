import React from 'react';
import type { ReactNode } from 'react';
import { CaptureScopeSchema } from '@siftkit/contracts';
import type {
  AssistantConfig,
  AssistantBackgroundWorkDecisionDto,
  DesktopStateDto,
  PendingCaptureDto,
} from '../../types.ts';
import {
  bootstrapAssistantToken,
  getAssistantBackgroundDecisions,
  getAssistantDesktopState,
  getAssistantPendingCaptures,
} from '../../assistant-api.ts';
import { fetchVaultAttachment } from '../../vault-api.ts';
import { ImageLightbox } from '../../components/ImageLightbox.tsx';
import { AssistantMaintenance } from './AssistantMaintenance.tsx';

type AssistantView = 'configuration' | 'captures';

type AssistantSettingsProps = {
  assistant: AssistantConfig;
  onChange(value: AssistantConfig): void;
};

type CapturePreview =
  | { kind: 'url'; url: string }
  | { kind: 'error'; error: string };

const BACKGROUND_REASON_LABELS = {
  drain_blocked: 'Drain blocked',
  assistant_disabled: 'Assistant disabled',
  drain_already_running: 'Drain already running',
  preemption_requested: 'Preemption requested',
  server_busy: 'Server busy',
  environment_heartbeat_missing: 'Environment heartbeat missing',
  model_recently_active: 'Model recently active',
  mouse_idle_below_threshold: 'Mouse idle below threshold',
  keyboard_idle_below_threshold: 'Keyboard idle below threshold',
  on_battery: 'Running on battery',
  battery_below_minimum: 'Battery below minimum',
  daily_gpu_limit: 'Daily GPU limit reached',
  model_not_resident: 'Model not resident',
  image_capability_unavailable: 'Image capability unavailable',
  no_claimable_job: 'No queued job is currently claimable',
} satisfies Record<AssistantBackgroundWorkDecisionDto['reason'], string>;

function BackgroundWorkDecisions(props: {
  items: readonly AssistantBackgroundWorkDecisionDto[];
  loading: boolean;
}) {
  return (
    <section className="assistant-feed">
      <h2>Background work decisions</h2>
      {props.loading ? <p className="hint">Loading background-work decisions…</p> : null}
      {!props.loading && props.items.length === 0 ? (
        <p className="hint">No background-work blocks have been recorded.</p>
      ) : null}
      {props.items.map((item, index) => (
        <article className="assistant-feed-card" key={`${item.recordedAtUtc}:${item.reason}:${index}`}>
          <div className="assistant-card-heading">
            <h3>{BACKGROUND_REASON_LABELS[item.reason]}</h3>
            <span className="bdg">{new Date(item.recordedAtUtc).toLocaleString()}</span>
          </div>
          <p className="hint">
            {item.queuedJobCount} queued jobs · {item.pendingCaptureCount} pending captures
          </p>
          {Object.entries(item.details).map(([name, value]) => (
            <p className="assistant-proof" key={name}>{name}: {String(value)}</p>
          ))}
        </article>
      ))}
    </section>
  );
}

function Toggle(props: { label: string; value: boolean; onChange(value: boolean): void }) {
  return (
    <label className="assistant-setting">
      <span>{props.label}</span>
      <span className="settings-live-toggle-control">
        <input
          type="checkbox"
          checked={props.value}
          onChange={(event) => props.onChange(event.target.checked)}
        />
        {props.value ? 'Enabled' : 'Disabled'}
      </span>
    </label>
  );
}

function NumberField(props: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange(value: number): void;
}) {
  return (
    <label className="assistant-setting">
      <span>{props.label}</span>
      <input
        type="number"
        value={props.value}
        min={props.min}
        max={props.max}
        step={props.step}
        onChange={(event) => {
          const value = Number(event.target.value);
          if (Number.isFinite(value)) props.onChange(value);
        }}
      />
    </label>
  );
}

function TextField(props: {
  label: string;
  value: string;
  type?: 'text' | 'time' | 'datetime-local';
  onChange(value: string): void;
}) {
  return (
    <label className="assistant-setting">
      <span>{props.label}</span>
      <input
        type={props.type ?? 'text'}
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
      />
    </label>
  );
}

function SelectField(props: {
  label: string;
  value: string;
  options: readonly { value: string; label: string }[];
  onChange(value: string): void;
}) {
  return (
    <label className="assistant-setting">
      <span>{props.label}</span>
      <select value={props.value} onChange={(event) => props.onChange(event.target.value)}>
        {props.options.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
    </label>
  );
}

/**
 * One entry per line; the config stores the trimmed, non-empty lines. The display derives from
 * `values` so outside writers stay visible; only an in-progress edit holds a raw draft, and
 * blur reconciles it back to the stored form.
 */
function ListField(props: {
  label: string;
  values: readonly string[];
  onChange(values: string[]): void;
}) {
  const [draft, setDraft] = React.useState<string | null>(null);
  return (
    <label className="assistant-setting">
      <span>{props.label}</span>
      <textarea
        rows={3}
        value={draft ?? props.values.join('\n')}
        onChange={(event) => {
          setDraft(event.target.value);
          props.onChange(event.target.value
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line.length > 0));
        }}
        onBlur={() => setDraft(null)}
      />
    </label>
  );
}

function Group(props: { title: string; children: ReactNode }) {
  return (
    <section className="assistant-settings-group">
      <h3>{props.title}</h3>
      <div className="assistant-settings-grid">{props.children}</div>
    </section>
  );
}

const CAPTURE_SCOPE_OPTIONS = [
  { value: 'foreground_window', label: 'Foreground window' },
  { value: 'all_monitors', label: 'All monitors' },
] as const;

function custodyLabel(state: DesktopStateDto): string {
  return state.custody.custody === 'file'
    ? 'local file key'
    : 'Windows account (DPAPI)';
}

type ObservationSettingsProps = AssistantSettingsProps & {
  desktopState: DesktopStateDto | null;
};

/** The Gate D observation surface (spec §6): consent-first capture controls plus live status. */
function ObservationSettings(props: ObservationSettingsProps) {
  const { assistant, onChange, desktopState } = props;
  const observation = assistant.Observation;
  function patch(next: Partial<AssistantConfig['Observation']>): void {
    onChange({ ...assistant, Observation: { ...observation, ...next } });
  }
  return (
    <Group title="Observation">
      {desktopState !== null ? (
        <p className="hint assistant-custody-status">
          Key custody: {custodyLabel(desktopState)}
          {desktopState.custody.imported ? ' (imported this session)' : ''}
        </p>
      ) : null}
      {desktopState !== null && !desktopState.imageCapability.capable ? (
        <p className="assistant-capability-warning" role="alert">
          No vision-capable model is active — {desktopState.imageCapability.queueDepth} captures
          are waiting for image analysis.
        </p>
      ) : null}
      <Toggle label="Screenshots" value={observation.ScreenshotsEnabled} onChange={(ScreenshotsEnabled) => patch({ ScreenshotsEnabled })} />
      <p className="hint assistant-consent-text">
        Screenshots are captured silently, stored encrypted on this device, and never leave it.
        Turning screenshots on enables automatic image analysis of what is on your screen.
      </p>
      <Toggle label="Activity metadata" value={observation.ActivityMetadataEnabled} onChange={(ActivityMetadataEnabled) => patch({ ActivityMetadataEnabled })} />
      <NumberField label="Fixed cadence seconds" value={observation.FixedCadenceSeconds} min={1} onChange={(FixedCadenceSeconds) => patch({ FixedCadenceSeconds })} />
      <SelectField label="Capture scope" value={observation.CaptureScope} options={CAPTURE_SCOPE_OPTIONS} onChange={(value) => patch({ CaptureScope: CaptureScopeSchema.parse(value) })} />
      <Toggle label="Window-change capture" value={observation.WindowChangeCapture} onChange={(WindowChangeCapture) => patch({ WindowChangeCapture })} />
      <NumberField label="Minimum foreground dwell seconds" value={observation.MinimumForegroundDwellSeconds} min={0} onChange={(MinimumForegroundDwellSeconds) => patch({ MinimumForegroundDwellSeconds })} />
      <NumberField label="Duplicate similarity percent" value={observation.DuplicateSimilarityPercent} min={0} max={100} onChange={(DuplicateSimilarityPercent) => patch({ DuplicateSimilarityPercent })} />
      <Toggle label="Capture only while active" value={observation.CaptureOnlyWhileActive} onChange={(CaptureOnlyWhileActive) => patch({ CaptureOnlyWhileActive })} />
      <Toggle label="Skip fullscreen" value={observation.SkipFullscreen} onChange={(SkipFullscreen) => patch({ SkipFullscreen })} />
      <Toggle label="Skip while locked" value={observation.SkipWhileLocked} onChange={(SkipWhileLocked) => patch({ SkipWhileLocked })} />
      <ListField label="Process deny list (one per line)" values={observation.ProcessDenyList} onChange={(ProcessDenyList) => patch({ ProcessDenyList })} />
      <ListField label="Title deny patterns (one per line)" values={observation.TitleDenyPatterns} onChange={(TitleDenyPatterns) => patch({ TitleDenyPatterns })} />
      <NumberField label="Raw retention hours" value={observation.RawRetentionHours} min={1} onChange={(RawRetentionHours) => patch({ RawRetentionHours })} />
      <NumberField label="Raw storage limit GB" value={observation.RawStorageLimitGb} min={0.1} step={0.1} onChange={(RawStorageLimitGb) => patch({ RawStorageLimitGb })} />
      <Toggle label="Accessibility extraction" value={observation.AccessibilityExtractionEnabled} onChange={(AccessibilityExtractionEnabled) => patch({ AccessibilityExtractionEnabled })} />
      <Toggle label="OCR fallback" value={observation.OcrFallbackEnabled} onChange={(OcrFallbackEnabled) => patch({ OcrFallbackEnabled })} />
      <Toggle label="Start SiftKit Assistant when I sign in" value={observation.StartOnSignIn} onChange={(StartOnSignIn) => patch({ StartOnSignIn })} />
    </Group>
  );
}

function AssistantConfiguration(props: ObservationSettingsProps) {
  const { assistant, onChange } = props;
  const priorities = assistant.Background.JobPriorities;
  function patchPriorities(next: Partial<AssistantConfig['Background']['JobPriorities']>): void {
    onChange({ ...assistant, Background: { ...assistant.Background, JobPriorities: { ...priorities, ...next } } });
  }
  return (
    <div className="assistant-config-groups">
      <Group title="General">
        <Toggle label="Assistant enabled" value={assistant.Enabled} onChange={(Enabled) => onChange({ ...assistant, Enabled })} />
        <TextField label="Owner ID" value={assistant.Owner.Id} onChange={(Id) => onChange({ ...assistant, Owner: { ...assistant.Owner, Id } })} />
        <TextField label="Owner display name" value={assistant.Owner.DisplayName} onChange={(DisplayName) => onChange({ ...assistant, Owner: { ...assistant.Owner, DisplayName } })} />
      </Group>
      <Group title="Retrieval">
        <NumberField label="Max context tokens" value={assistant.Retrieval.MaxContextTokens} min={1} onChange={(MaxContextTokens) => onChange({ ...assistant, Retrieval: { ...assistant.Retrieval, MaxContextTokens } })} />
        <NumberField label="Max notes" value={assistant.Retrieval.MaxNotes} min={1} onChange={(MaxNotes) => onChange({ ...assistant, Retrieval: { ...assistant.Retrieval, MaxNotes } })} />
      </Group>
      <Group title="Vault">
        <Toggle label="Tidy pass" value={assistant.Vault.TidyPassEnabled} onChange={(TidyPassEnabled) => onChange({ ...assistant, Vault: { ...assistant.Vault, TidyPassEnabled } })} />
        <NumberField label="Capture image max age days (0 keeps them)" value={assistant.Vault.CaptureImageMaxAgeDays} min={0} onChange={(CaptureImageMaxAgeDays) => onChange({ ...assistant, Vault: { ...assistant.Vault, CaptureImageMaxAgeDays } })} />
      </Group>
      <ObservationSettings
        assistant={assistant}
        onChange={onChange}
        desktopState={props.desktopState}
      />
      <Group title="Background work">
        <NumberField label="Idle seconds before processing" value={assistant.Background.IdleSecondsBeforeProcessing} min={0} onChange={(IdleSecondsBeforeProcessing) => onChange({ ...assistant, Background: { ...assistant.Background, IdleSecondsBeforeProcessing } })} />
        <NumberField label="Max jobs/idle session" value={assistant.Background.MaxJobsPerIdleSession} min={1} onChange={(MaxJobsPerIdleSession) => onChange({ ...assistant, Background: { ...assistant.Background, MaxJobsPerIdleSession } })} />
        <NumberField label="Max GPU minutes/day" value={assistant.Background.MaxGpuMinutesPerDay} min={0} onChange={(MaxGpuMinutesPerDay) => onChange({ ...assistant, Background: { ...assistant.Background, MaxGpuMinutesPerDay } })} />
        <NumberField label="Minimum battery percent" value={assistant.Background.MinimumBatteryPercent} min={0} max={100} onChange={(MinimumBatteryPercent) => onChange({ ...assistant, Background: { ...assistant.Background, MinimumBatteryPercent } })} />
        <Toggle label="Allow on battery" value={assistant.Background.AllowOnBattery} onChange={(AllowOnBattery) => onChange({ ...assistant, Background: { ...assistant.Background, AllowOnBattery } })} />
        <NumberField label="Chat note priority" value={priorities.ChatNote} onChange={(ChatNote) => patchPriorities({ ChatNote })} />
        <NumberField label="Capture note priority" value={priorities.CaptureNote} onChange={(CaptureNote) => patchPriorities({ CaptureNote })} />
        <NumberField label="Daily rollup priority" value={priorities.DailyRollup} onChange={(DailyRollup) => patchPriorities({ DailyRollup })} />
        <NumberField label="Note tidy priority" value={priorities.NoteTidy} onChange={(NoteTidy) => patchPriorities({ NoteTidy })} />
        <NumberField label="Capture retention priority" value={priorities.CaptureRetention} onChange={(CaptureRetention) => patchPriorities({ CaptureRetention })} />
      </Group>
      <Group title="Private mode">
        <Toggle label="Private mode active" value={assistant.PrivateMode.Active} onChange={(Active) => onChange({ ...assistant, PrivateMode: { ...assistant.PrivateMode, Active } })} />
        <TextField label="Expires at (UTC)" value={assistant.PrivateMode.ExpiresAtUtc ?? ''} onChange={(value) => onChange({ ...assistant, PrivateMode: { ...assistant.PrivateMode, ExpiresAtUtc: value.trim() || null } })} />
      </Group>
    </div>
  );
}

/** Captures still owed their note-writer pass, previewed from their vault attachments. */
function PendingCaptures(props: { token: string | null; captures: readonly PendingCaptureDto[]; loading: boolean }) {
  const { token, captures } = props;
  const [previews, setPreviews] = React.useState<Record<string, CapturePreview>>({});
  const [zoomed, setZoomed] = React.useState<PendingCaptureDto | null>(null);

  // Previews load lazily once the list has arrived; each blob is held as an object URL until unmount.
  React.useEffect(() => {
    if (token === null || captures.length === 0) return;
    let active = true;
    const urls: string[] = [];
    void (async () => {
      for (const capture of captures) {
        try {
          const blob = await fetchVaultAttachment(token, capture.relativePath);
          if (!active) return;
          const url = window.URL.createObjectURL(blob);
          urls.push(url);
          setPreviews((prev) => ({ ...prev, [capture.attachmentId]: { kind: 'url', url } }));
        } catch (caught) {
          if (!active) return;
          setPreviews((prev) => ({
            ...prev,
            [capture.attachmentId]: { kind: 'error', error: caught instanceof Error ? caught.message : String(caught) },
          }));
        }
      }
    })();
    return () => {
      active = false;
      for (const url of urls) window.URL.revokeObjectURL(url);
    };
  }, [token, captures]);

  const zoomedPreview = zoomed === null ? undefined : previews[zoomed.attachmentId];
  if (props.loading) return <p className="hint">Loading pending captures…</p>;
  if (captures.length === 0) return <p className="hint">No captures are waiting for the note-writer.</p>;
  return (
    <section className="assistant-pending-captures">
      {captures.map((capture) => {
        const preview = previews[capture.attachmentId];
        return (
          <article className="assistant-feed-card" key={capture.attachmentId}>
            <div className="assistant-card-heading">
              <h3>{capture.noteTitle}</h3>
              <span className="bdg">{capture.state.replace(/_/g, ' ')}</span>
            </div>
            {preview === undefined ? (
              <p className="hint">Loading preview…</p>
            ) : preview.kind === 'url' ? (
              <button
                type="button"
                className="image-zoom"
                aria-label={`Enlarge capture ${capture.noteTitle}`}
                title="Enlarge"
                onClick={() => setZoomed(capture)}
              >
                <img src={preview.url} alt={capture.noteTitle} />
              </button>
            ) : (
              <p className="error">Preview unavailable: {preview.error}</p>
            )}
            <p className="hint">{new Date(capture.capturedAtUtc).toLocaleString()} · {(capture.byteLength / 1024).toFixed(1)} KB</p>
          </article>
        );
      })}
      {zoomed !== null && zoomedPreview !== undefined && zoomedPreview.kind === 'url' ? (
        <ImageLightbox src={zoomedPreview.url} alt={zoomed.noteTitle} onClose={() => setZoomed(null)} />
      ) : null}
    </section>
  );
}

export function AssistantSettings(props: AssistantSettingsProps) {
  const [view, setView] = React.useState<AssistantView>('configuration');
  const [token, setToken] = React.useState<string | null>(null);
  const [desktopState, setDesktopState] = React.useState<DesktopStateDto | null>(null);
  const [pendingCaptures, setPendingCaptures] = React.useState<PendingCaptureDto[]>([]);
  const [backgroundDecisions, setBackgroundDecisions] = React.useState<
    AssistantBackgroundWorkDecisionDto[]
  >([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const nextToken = await bootstrapAssistantToken();
        const [nextDesktopState, nextCaptures, nextBackgroundDecisions] = await Promise.all([
          getAssistantDesktopState(nextToken),
          getAssistantPendingCaptures(nextToken),
          getAssistantBackgroundDecisions(nextToken),
        ]);
        if (!active) return;
        setToken(nextToken);
        setDesktopState(nextDesktopState);
        setPendingCaptures(nextCaptures.captures);
        setBackgroundDecisions(nextBackgroundDecisions);
      } catch (caught) {
        if (active) setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, []);

  return (
    <div className="assistant-settings">
      <div className="segc assistant-view-nav" aria-label="Assistant settings view">
        <button type="button" className={view === 'configuration' ? 'on' : ''} onClick={() => setView('configuration')}>Configuration</button>
        <button type="button" className={view === 'captures' ? 'on' : ''} onClick={() => setView('captures')}>Pending captures</button>
      </div>
      <p className="assistant-security-note">Evidence is encrypted at rest; the active key custody is shown under Observation.</p>
      {error ? <p className="error" role="alert">{error}</p> : null}
      {view === 'configuration' ? (
        <>
          <AssistantConfiguration {...props} desktopState={desktopState} />
          <AssistantMaintenance token={token} />
          <BackgroundWorkDecisions items={backgroundDecisions} loading={loading} />
        </>
      ) : (
        <div className="assistant-feed">
          <PendingCaptures token={token} captures={pendingCaptures} loading={loading} />
        </div>
      )}
    </div>
  );
}
