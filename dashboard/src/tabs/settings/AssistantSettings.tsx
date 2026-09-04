import React from 'react';
import type { ReactNode } from 'react';
import { CaptureScopeSchema } from '@siftkit/contracts';
import type {
  AssistantConfig,
  AssistantBackgroundWorkDecisionDto,
  AssistantMemoryHistoryEntryDto,
  AssistantValidationCandidateDto,
  DesktopStateDto,
  PendingCaptureDto,
} from '../../types.js';
import {
  bootstrapAssistantToken,
  fetchAssistantEvidencePixels,
  getAssistantBackgroundDecisions,
  getAssistantDesktopState,
  getAssistantMemoryHistory,
  getAssistantPendingCaptures,
  getAssistantValidation,
  removeAssistantValidationCandidate,
  resolveAssistantCandidateIdentity,
  saveAssistantValidationNotes,
} from '../../assistant-api.js';
import { ImageLightbox } from '../../components/ImageLightbox.js';
import { AssistantMaintenance } from './AssistantMaintenance.js';

type AssistantView = 'configuration' | 'validation' | 'history';

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
  return (
    <div className="assistant-config-groups">
      <Group title="General">
        <Toggle label="Assistant enabled" value={assistant.Enabled} onChange={(Enabled) => onChange({ ...assistant, Enabled })} />
        <TextField label="Owner ID" value={assistant.Owner.Id} onChange={(Id) => onChange({ ...assistant, Owner: { ...assistant.Owner, Id } })} />
        <TextField label="Owner display name" value={assistant.Owner.DisplayName} onChange={(DisplayName) => onChange({ ...assistant, Owner: { ...assistant.Owner, DisplayName } })} />
      </Group>
      <Group title="Memory budgets">
        <NumberField label="Tier 1 max tokens" value={assistant.Memory.Tier1.MaxTokens} min={1} onChange={(MaxTokens) => onChange({ ...assistant, Memory: { ...assistant.Memory, Tier1: { ...assistant.Memory.Tier1, MaxTokens } } })} />
        <NumberField label="Tier 1 target tokens" value={assistant.Memory.Tier1.TargetTokens} min={1} onChange={(TargetTokens) => onChange({ ...assistant, Memory: { ...assistant.Memory, Tier1: { ...assistant.Memory.Tier1, TargetTokens } } })} />
        <NumberField label="Tier 2 max documents" value={assistant.Memory.Tier2.MaxDocuments} min={1} onChange={(MaxDocuments) => onChange({ ...assistant, Memory: { ...assistant.Memory, Tier2: { ...assistant.Memory.Tier2, MaxDocuments } } })} />
        <NumberField label="Tier 2 max tokens/document" value={assistant.Memory.Tier2.MaxTokensPerDocument} min={1} onChange={(MaxTokensPerDocument) => onChange({ ...assistant, Memory: { ...assistant.Memory, Tier2: { ...assistant.Memory.Tier2, MaxTokensPerDocument } } })} />
        <NumberField label="Tier 2 target tokens/document" value={assistant.Memory.Tier2.TargetTokensPerDocument} min={1} onChange={(TargetTokensPerDocument) => onChange({ ...assistant, Memory: { ...assistant.Memory, Tier2: { ...assistant.Memory.Tier2, TargetTokensPerDocument } } })} />
        <NumberField label="Tier 3 max documents" value={assistant.Memory.Tier3.MaxDocuments} min={1} onChange={(MaxDocuments) => onChange({ ...assistant, Memory: { ...assistant.Memory, Tier3: { ...assistant.Memory.Tier3, MaxDocuments } } })} />
        <NumberField label="Tier 3 max tokens/document" value={assistant.Memory.Tier3.MaxTokensPerDocument} min={1} onChange={(MaxTokensPerDocument) => onChange({ ...assistant, Memory: { ...assistant.Memory, Tier3: { ...assistant.Memory.Tier3, MaxTokensPerDocument } } })} />
        <NumberField label="Tier 3 target tokens/document" value={assistant.Memory.Tier3.TargetTokensPerDocument} min={1} onChange={(TargetTokensPerDocument) => onChange({ ...assistant, Memory: { ...assistant.Memory, Tier3: { ...assistant.Memory.Tier3, TargetTokensPerDocument } } })} />
      </Group>
      <Group title="Retrieval">
        <NumberField label="Max context tokens" value={assistant.Retrieval.MaxContextTokens} min={1} onChange={(MaxContextTokens) => onChange({ ...assistant, Retrieval: { ...assistant.Retrieval, MaxContextTokens } })} />
        <NumberField label="Max hops" value={assistant.Retrieval.MaxHops} min={1} max={3} onChange={(MaxHops) => onChange({ ...assistant, Retrieval: { ...assistant.Retrieval, MaxHops } })} />
        <NumberField label="Max seed nodes" value={assistant.Retrieval.MaxSeedNodes} min={1} onChange={(MaxSeedNodes) => onChange({ ...assistant, Retrieval: { ...assistant.Retrieval, MaxSeedNodes } })} />
        <NumberField label="Max nodes" value={assistant.Retrieval.MaxNodes} min={1} onChange={(MaxNodes) => onChange({ ...assistant, Retrieval: { ...assistant.Retrieval, MaxNodes } })} />
        <NumberField label="Max assertions" value={assistant.Retrieval.MaxAssertions} min={1} onChange={(MaxAssertions) => onChange({ ...assistant, Retrieval: { ...assistant.Retrieval, MaxAssertions } })} />
        <NumberField label="Max fanout/node predicate" value={assistant.Retrieval.MaxFanoutPerNodePredicate} min={1} onChange={(MaxFanoutPerNodePredicate) => onChange({ ...assistant, Retrieval: { ...assistant.Retrieval, MaxFanoutPerNodePredicate } })} />
      </Group>
      <Group title="Questions">
        <Toggle label="Questions enabled" value={assistant.Questions.Enabled} onChange={(Enabled) => onChange({ ...assistant, Questions: { ...assistant.Questions, Enabled } })} />
        <NumberField label="Max/day" value={assistant.Questions.MaxPerDay} min={0} onChange={(MaxPerDay) => onChange({ ...assistant, Questions: { ...assistant.Questions, MaxPerDay } })} />
        <NumberField label="Max/week" value={assistant.Questions.MaxPerWeek} min={0} onChange={(MaxPerWeek) => onChange({ ...assistant, Questions: { ...assistant.Questions, MaxPerWeek } })} />
        <NumberField label="Minimum hours between" value={assistant.Questions.MinimumHoursBetweenQuestions} min={0} onChange={(MinimumHoursBetweenQuestions) => onChange({ ...assistant, Questions: { ...assistant.Questions, MinimumHoursBetweenQuestions } })} />
        <TextField label="Allowed start" type="time" value={assistant.Questions.AllowedLocalTimeStart} onChange={(AllowedLocalTimeStart) => onChange({ ...assistant, Questions: { ...assistant.Questions, AllowedLocalTimeStart } })} />
        <TextField label="Allowed end" type="time" value={assistant.Questions.AllowedLocalTimeEnd} onChange={(AllowedLocalTimeEnd) => onChange({ ...assistant, Questions: { ...assistant.Questions, AllowedLocalTimeEnd } })} />
        <NumberField label="Dismissed cooldown days" value={assistant.Questions.DismissedCooldownDays} min={0} onChange={(DismissedCooldownDays) => onChange({ ...assistant, Questions: { ...assistant.Questions, DismissedCooldownDays } })} />
        <NumberField label="Unanswered expiry days" value={assistant.Questions.UnansweredExpiryDays} min={1} onChange={(UnansweredExpiryDays) => onChange({ ...assistant, Questions: { ...assistant.Questions, UnansweredExpiryDays } })} />
        <Toggle label="Suppress during fullscreen" value={assistant.Questions.SuppressDuringFullscreen} onChange={(SuppressDuringFullscreen) => onChange({ ...assistant, Questions: { ...assistant.Questions, SuppressDuringFullscreen } })} />
        <Toggle label="Suppress during do-not-disturb" value={assistant.Questions.SuppressDuringDoNotDisturb} onChange={(SuppressDuringDoNotDisturb) => onChange({ ...assistant, Questions: { ...assistant.Questions, SuppressDuringDoNotDisturb } })} />
        <NumberField label="Active input suppression seconds" value={assistant.Questions.ActiveInputSuppressionSeconds} min={0} onChange={(ActiveInputSuppressionSeconds) => onChange({ ...assistant, Questions: { ...assistant.Questions, ActiveInputSuppressionSeconds } })} />
      </Group>
      <ObservationSettings
        assistant={assistant}
        onChange={onChange}
        desktopState={props.desktopState}
      />
      <Group title="Retention">
        <NumberField label="OCR text days" value={assistant.Retention.OcrTextDays} min={1} onChange={(OcrTextDays) => onChange({ ...assistant, Retention: { ...assistant.Retention, OcrTextDays } })} />
        <NumberField label="Unpromoted observation days" value={assistant.Retention.UnpromotedObservationDays} min={1} onChange={(UnpromotedObservationDays) => onChange({ ...assistant, Retention: { ...assistant.Retention, UnpromotedObservationDays } })} />
        <NumberField label="Rejected candidate days" value={assistant.Retention.RejectedCandidateDays} min={1} onChange={(RejectedCandidateDays) => onChange({ ...assistant, Retention: { ...assistant.Retention, RejectedCandidateDays } })} />
      </Group>
      <Group title="Background work">
        <NumberField label="Idle seconds before processing" value={assistant.Background.IdleSecondsBeforeProcessing} min={0} onChange={(IdleSecondsBeforeProcessing) => onChange({ ...assistant, Background: { ...assistant.Background, IdleSecondsBeforeProcessing } })} />
        <NumberField label="Max jobs/idle session" value={assistant.Background.MaxJobsPerIdleSession} min={1} onChange={(MaxJobsPerIdleSession) => onChange({ ...assistant, Background: { ...assistant.Background, MaxJobsPerIdleSession } })} />
        <NumberField label="Max GPU minutes/day" value={assistant.Background.MaxGpuMinutesPerDay} min={0} onChange={(MaxGpuMinutesPerDay) => onChange({ ...assistant, Background: { ...assistant.Background, MaxGpuMinutesPerDay } })} />
        <NumberField label="Minimum battery percent" value={assistant.Background.MinimumBatteryPercent} min={0} max={100} onChange={(MinimumBatteryPercent) => onChange({ ...assistant, Background: { ...assistant.Background, MinimumBatteryPercent } })} />
        <Toggle label="Allow on battery" value={assistant.Background.AllowOnBattery} onChange={(AllowOnBattery) => onChange({ ...assistant, Background: { ...assistant.Background, AllowOnBattery } })} />
        <NumberField label="Conversation ingestion priority" value={assistant.Background.JobPriorities.ConversationIngestion} onChange={(ConversationIngestion) => onChange({ ...assistant, Background: { ...assistant.Background, JobPriorities: { ...assistant.Background.JobPriorities, ConversationIngestion } } })} />
        <NumberField label="Question answer priority" value={assistant.Background.JobPriorities.QuestionAnswerIngestion} onChange={(QuestionAnswerIngestion) => onChange({ ...assistant, Background: { ...assistant.Background, JobPriorities: { ...assistant.Background.JobPriorities, QuestionAnswerIngestion } } })} />
        <NumberField label="Question planning priority" value={assistant.Background.JobPriorities.QuestionPlanning} onChange={(QuestionPlanning) => onChange({ ...assistant, Background: { ...assistant.Background, JobPriorities: { ...assistant.Background.JobPriorities, QuestionPlanning } } })} />
        <NumberField label="Candidate consolidation priority" value={assistant.Background.JobPriorities.CandidateConsolidation} onChange={(CandidateConsolidation) => onChange({ ...assistant, Background: { ...assistant.Background, JobPriorities: { ...assistant.Background.JobPriorities, CandidateConsolidation } } })} />
        <NumberField label="Projection maintenance priority" value={assistant.Background.JobPriorities.ProjectionMaintenance} onChange={(ProjectionMaintenance) => onChange({ ...assistant, Background: { ...assistant.Background, JobPriorities: { ...assistant.Background.JobPriorities, ProjectionMaintenance } } })} />
      </Group>
      <Group title="Private mode">
        <Toggle label="Private mode active" value={assistant.PrivateMode.Active} onChange={(Active) => onChange({ ...assistant, PrivateMode: { ...assistant.PrivateMode, Active } })} />
        <TextField label="Expires at (UTC)" value={assistant.PrivateMode.ExpiresAtUtc ?? ''} onChange={(value) => onChange({ ...assistant, PrivateMode: { ...assistant.PrivateMode, ExpiresAtUtc: value.trim() || null } })} />
      </Group>
    </div>
  );
}

export function AssistantSettings(props: AssistantSettingsProps) {
  const [view, setView] = React.useState<AssistantView>('configuration');
  const [token, setToken] = React.useState<string | null>(null);
  const [validation, setValidation] = React.useState<AssistantValidationCandidateDto[]>([]);
  const [history, setHistory] = React.useState<AssistantMemoryHistoryEntryDto[]>([]);
  const [desktopState, setDesktopState] = React.useState<DesktopStateDto | null>(null);
  const [pendingCaptures, setPendingCaptures] = React.useState<PendingCaptureDto[]>([]);
  const [backgroundDecisions, setBackgroundDecisions] = React.useState<
    AssistantBackgroundWorkDecisionDto[]
  >([]);
  const [capturePreviews, setCapturePreviews] = React.useState<Record<string, CapturePreview>>({});
  const [zoomedCapture, setZoomedCapture] = React.useState<PendingCaptureDto | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const nextToken = await bootstrapAssistantToken();
        const [
          nextValidation, nextHistory, nextDesktopState, nextCaptures, nextBackgroundDecisions,
        ] = await Promise.all([
          getAssistantValidation(nextToken),
          getAssistantMemoryHistory(nextToken),
          getAssistantDesktopState(nextToken),
          getAssistantPendingCaptures(nextToken),
          getAssistantBackgroundDecisions(nextToken),
        ]);
        if (!active) return;
        setToken(nextToken);
        setValidation(nextValidation);
        setHistory(nextHistory);
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

  // Pixel fetches are lazy: they start only once the capture list has loaded, and each
  // decrypted blob is held as an object URL until the view unmounts or reloads the list.
  React.useEffect(() => {
    if (token === null || pendingCaptures.length === 0) return;
    let active = true;
    const urls: string[] = [];
    void (async () => {
      for (const capture of pendingCaptures) {
        try {
          const blob = await fetchAssistantEvidencePixels(token, capture.evidenceId);
          if (!active) return;
          const url = window.URL.createObjectURL(blob);
          urls.push(url);
          setCapturePreviews((prev) => ({ ...prev, [capture.evidenceId]: { kind: 'url', url } }));
        } catch (caught) {
          if (!active) return;
          setCapturePreviews((prev) => ({
            ...prev,
            [capture.evidenceId]: { kind: 'error', error: caught instanceof Error ? caught.message : String(caught) },
          }));
        }
      }
    })();
    return () => {
      active = false;
      for (const url of urls) window.URL.revokeObjectURL(url);
    };
  }, [token, pendingCaptures]);

  async function saveNotes(candidate: AssistantValidationCandidateDto): Promise<void> {
    if (token === null) return;
    try {
      await saveAssistantValidationNotes(token, candidate.id, candidate.userNotes);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  /**
   * Answers the identity hold. Only a promotion removes the card: a rejection or a second hold
   * leaves the candidate in the queue, so the list is reloaded and the reason shown.
   */
  async function resolveIdentity(
    candidate: AssistantValidationCandidateDto, isOwner: boolean,
  ): Promise<void> {
    if (token === null) return;
    try {
      const result = await resolveAssistantCandidateIdentity(token, candidate.id, isOwner);
      if (result.outcome === 'promoted') {
        setValidation((items) => items.filter((item) => item.id !== candidate.id));
        return;
      }
      setValidation(await getAssistantValidation(token));
      setError(result.outcome === 'rejected'
        ? `“${candidate.proposedStatement}” could not be written and stays in the queue.`
        : `“${candidate.proposedStatement}” raised another question and stays in the queue.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  async function removeCandidate(candidate: AssistantValidationCandidateDto): Promise<void> {
    if (token === null || !window.confirm(`Remove “${candidate.proposedStatement}” from validation?`)) return;
    try {
      await removeAssistantValidationCandidate(token, candidate.id);
      setValidation((items) => items.filter((item) => item.id !== candidate.id));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  const zoomedPreview = zoomedCapture === null ? undefined : capturePreviews[zoomedCapture.evidenceId];

  return (
    <div className="assistant-settings">
      <div className="segc assistant-view-nav" aria-label="Assistant settings view">
        <button type="button" className={view === 'configuration' ? 'on' : ''} onClick={() => setView('configuration')}>Configuration</button>
        <button type="button" className={view === 'validation' ? 'on' : ''} onClick={() => setView('validation')}>Pending validation</button>
        <button type="button" className={view === 'history' ? 'on' : ''} onClick={() => setView('history')}>Memory history</button>
      </div>
      <p className="assistant-security-note">Evidence is encrypted at rest; the active key custody is shown under Observation.</p>
      {error ? <p className="error" role="alert">{error}</p> : null}
      {view === 'configuration' ? (
        <>
          <AssistantConfiguration {...props} desktopState={desktopState} />
          <AssistantMaintenance token={token} />
          <BackgroundWorkDecisions items={backgroundDecisions} loading={loading} />
        </>
      ) : null}
      {view === 'validation' ? (
        <div className="assistant-feed">
          {loading ? <p className="hint">Loading pending proof…</p> : null}
          {!loading ? (
            <section className="assistant-pending-captures">
              {pendingCaptures.length === 0 ? (
                <p className="hint">No captures are waiting for image analysis.</p>
              ) : (
                <>
                  <h3>Pending captures</h3>
                  {pendingCaptures.map((capture) => {
                    const preview = capturePreviews[capture.evidenceId];
                    return (
                      <article className="assistant-feed-card" key={capture.evidenceId}>
                        <div className="assistant-card-heading">
                          <h3>{capture.foregroundContextKey}</h3>
                          <span className="bdg">{capture.state.replace(/_/g, ' ')}</span>
                        </div>
                        {preview === undefined ? (
                          <p className="hint">Loading preview…</p>
                        ) : preview.kind === 'url' ? (
                          <button
                            type="button"
                            className="image-zoom"
                            aria-label={`Enlarge capture ${capture.evidenceId}`}
                            title="Enlarge"
                            onClick={() => setZoomedCapture(capture)}
                          >
                            <img src={preview.url} alt={`Capture from ${capture.foregroundContextKey}`} />
                          </button>
                        ) : (
                          <p className="error">Preview unavailable: {preview.error}</p>
                        )}
                        <p className="hint">{new Date(capture.enqueuedAtUtc).toLocaleString()} · {(capture.byteLength / 1024).toFixed(1)} KB</p>
                      </article>
                    );
                  })}
                </>
              )}
            </section>
          ) : null}
          {!loading && validation.length === 0 ? <p className="hint">No proof is awaiting validation.</p> : null}
          {validation.map((candidate) => (
            <article className="assistant-feed-card" key={candidate.id}>
              <div className="assistant-card-heading">
                <h3>{candidate.proposedStatement}</h3>
                <span className="bdg">{candidate.status.replace('_', ' ')}</span>
                <span className="bdg">{Math.round(candidate.confidence * 100)}% confidence</span>
              </div>
              <p>{candidate.rationale}</p>
              <p className="hint">Proof: {candidate.evidenceId ?? 'No evidence reference'} · {candidate.sensitivity}</p>
              {candidate.hold?.kind === 'possible_owner_alias' ? (
                  <div className="assistant-identity-question">
                    <p>
                      “{candidate.hold.name}” is close to one of your own names. Is that you?
                      Nothing is written until you answer.
                    </p>
                    <div className="assistant-card-actions">
                      <button
                        type="button"
                        className="ghost-btn"
                        onClick={() => { void resolveIdentity(candidate, true); }}
                      >
                        Yes, that is me
                      </button>
                      <button
                        type="button"
                        className="ghost-btn"
                        onClick={() => { void resolveIdentity(candidate, false); }}
                      >
                        No, someone else
                      </button>
                    </div>
                  </div>
                ) : null}
              <label>
                <span className="assistant-notes-label">Your notes</span>
                <textarea
                  aria-label={`Notes for ${candidate.proposedStatement}`}
                  rows={3}
                  value={candidate.userNotes}
                  onChange={(event) => setValidation((items) => items.map((item) => (
                    item.id === candidate.id ? { ...item, userNotes: event.target.value } : item
                  )))}
                />
              </label>
              <div className="assistant-card-actions">
                <button type="button" className="ghost-btn" onClick={() => { void saveNotes(candidate); }}>Save notes</button>
                <button type="button" className="ghost-btn danger" onClick={() => { void removeCandidate(candidate); }}>Remove from queue</button>
              </div>
            </article>
          ))}
          {zoomedCapture !== null && zoomedPreview !== undefined && zoomedPreview.kind === 'url' ? (
            <ImageLightbox
              src={zoomedPreview.url}
              alt={`Capture from ${zoomedCapture.foregroundContextKey}`}
              onClose={() => setZoomedCapture(null)}
            />
          ) : null}
        </div>
      ) : null}
      {view === 'history' ? (
        <div className="assistant-feed">
          {loading ? <p className="hint">Loading memory history…</p> : null}
          {!loading && history.length === 0 ? <p className="hint">No memory changes have been recorded.</p> : null}
          {history.map((entry) => (
            <article className="assistant-feed-card" key={entry.id}>
              <div className="assistant-card-heading">
                <h3>{entry.summary}</h3>
                <span className="bdg">{entry.operation}</span>
              </div>
              <p>{entry.reason}</p>
              <p className="hint">{new Date(entry.createdAtUtc).toLocaleString()}</p>
              {entry.proofs.map((proof) => (
                <p className="assistant-proof" key={proof.evidenceId}>
                  Proof {proof.evidenceId} · {proof.sourceType}{proof.sourceRef ? ` · ${proof.sourceRef}` : ''}
                </p>
              ))}
            </article>
          ))}
        </div>
      ) : null}
    </div>
  );
}
