import React from 'react';
import type { ReactNode } from 'react';
import type {
  AssistantConfig,
  AssistantMemoryHistoryEntryDto,
  AssistantValidationCandidateDto,
} from '../../types.js';
import {
  bootstrapAssistantToken,
  getAssistantMemoryHistory,
  getAssistantValidation,
  removeAssistantValidationCandidate,
  saveAssistantValidationNotes,
} from '../../assistant-api.js';

type AssistantView = 'configuration' | 'validation' | 'history';

type AssistantSettingsProps = {
  assistant: AssistantConfig;
  onChange(value: AssistantConfig): void;
};

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

function Group(props: { title: string; children: ReactNode }) {
  return (
    <section className="assistant-settings-group">
      <h3>{props.title}</h3>
      <div className="assistant-settings-grid">{props.children}</div>
    </section>
  );
}

function AssistantConfiguration(props: AssistantSettingsProps) {
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
      <Group title="Observation">
        <Toggle label="Activity metadata" value={assistant.Observation.ActivityMetadataEnabled} onChange={(ActivityMetadataEnabled) => onChange({ ...assistant, Observation: { ...assistant.Observation, ActivityMetadataEnabled } })} />
        <Toggle label="Screenshots" value={assistant.Observation.ScreenshotsEnabled} onChange={(ScreenshotsEnabled) => onChange({ ...assistant, Observation: { ...assistant.Observation, ScreenshotsEnabled } })} />
        <NumberField label="Fixed cadence seconds" value={assistant.Observation.FixedCadenceSeconds} min={1} onChange={(FixedCadenceSeconds) => onChange({ ...assistant, Observation: { ...assistant.Observation, FixedCadenceSeconds } })} />
        <Toggle label="Window-change capture" value={assistant.Observation.WindowChangeCapture} onChange={(WindowChangeCapture) => onChange({ ...assistant, Observation: { ...assistant.Observation, WindowChangeCapture } })} />
        <NumberField label="Minimum foreground dwell seconds" value={assistant.Observation.MinimumForegroundDwellSeconds} min={0} onChange={(MinimumForegroundDwellSeconds) => onChange({ ...assistant, Observation: { ...assistant.Observation, MinimumForegroundDwellSeconds } })} />
        <NumberField label="Duplicate similarity percent" value={assistant.Observation.DuplicateSimilarityPercent} min={0} max={100} onChange={(DuplicateSimilarityPercent) => onChange({ ...assistant, Observation: { ...assistant.Observation, DuplicateSimilarityPercent } })} />
        <Toggle label="Capture only while active" value={assistant.Observation.CaptureOnlyWhileActive} onChange={(CaptureOnlyWhileActive) => onChange({ ...assistant, Observation: { ...assistant.Observation, CaptureOnlyWhileActive } })} />
        <Toggle label="Skip fullscreen" value={assistant.Observation.SkipFullscreen} onChange={(SkipFullscreen) => onChange({ ...assistant, Observation: { ...assistant.Observation, SkipFullscreen } })} />
        <Toggle label="Skip while locked" value={assistant.Observation.SkipWhileLocked} onChange={(SkipWhileLocked) => onChange({ ...assistant, Observation: { ...assistant.Observation, SkipWhileLocked } })} />
        <NumberField label="Raw retention hours" value={assistant.Observation.RawRetentionHours} min={1} onChange={(RawRetentionHours) => onChange({ ...assistant, Observation: { ...assistant.Observation, RawRetentionHours } })} />
        <NumberField label="Raw storage limit GB" value={assistant.Observation.RawStorageLimitGb} min={0.1} step={0.1} onChange={(RawStorageLimitGb) => onChange({ ...assistant, Observation: { ...assistant.Observation, RawStorageLimitGb } })} />
        <Toggle label="Accessibility extraction" value={assistant.Observation.AccessibilityExtractionEnabled} onChange={(AccessibilityExtractionEnabled) => onChange({ ...assistant, Observation: { ...assistant.Observation, AccessibilityExtractionEnabled } })} />
        <Toggle label="OCR fallback" value={assistant.Observation.OcrFallbackEnabled} onChange={(OcrFallbackEnabled) => onChange({ ...assistant, Observation: { ...assistant.Observation, OcrFallbackEnabled } })} />
      </Group>
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
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const nextToken = await bootstrapAssistantToken();
        const [nextValidation, nextHistory] = await Promise.all([
          getAssistantValidation(nextToken),
          getAssistantMemoryHistory(nextToken),
        ]);
        if (!active) return;
        setToken(nextToken);
        setValidation(nextValidation);
        setHistory(nextHistory);
      } catch (caught) {
        if (active) setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, []);

  async function saveNotes(candidate: AssistantValidationCandidateDto): Promise<void> {
    if (token === null) return;
    try {
      await saveAssistantValidationNotes(token, candidate.id, candidate.userNotes);
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

  return (
    <div className="assistant-settings">
      <div className="segc assistant-view-nav" aria-label="Assistant settings view">
        <button type="button" className={view === 'configuration' ? 'on' : ''} onClick={() => setView('configuration')}>Configuration</button>
        <button type="button" className={view === 'validation' ? 'on' : ''} onClick={() => setView('validation')}>Pending validation</button>
        <button type="button" className={view === 'history' ? 'on' : ''} onClick={() => setView('history')}>Memory history</button>
      </div>
      <p className="assistant-security-note">Evidence is encrypted with a local file key; OS keychain integration arrives in Gate D.</p>
      {error ? <p className="error" role="alert">{error}</p> : null}
      {view === 'configuration' ? <AssistantConfiguration {...props} /> : null}
      {view === 'validation' ? (
        <div className="assistant-feed">
          {loading ? <p className="hint">Loading pending proof…</p> : null}
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
