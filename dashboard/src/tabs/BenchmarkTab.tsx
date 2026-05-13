import React from 'react';
import type {
  DashboardBenchmarkAttempt,
  DashboardBenchmarkQuestionPreset,
  DashboardBenchmarkSession,
  DashboardBenchmarkSortKey,
  DashboardManagedLlamaPreset,
} from '../types';

export type BenchmarkTabProps = {
  questionPresets: DashboardBenchmarkQuestionPreset[];
  sessions: DashboardBenchmarkSession[];
  selectedSession: DashboardBenchmarkSession | null;
  attempts: DashboardBenchmarkAttempt[];
  liveLogLines: string[];
  managedPresets: DashboardManagedLlamaPreset[];
  selectedQuestionPresetIds: string[];
  selectedManagedPresetIds: string[];
  repetitions: number;
  specOverrideLabel: string;
  loading: boolean;
  error: string | null;
  starting: boolean;
  cancelling: boolean;
  sortKey: DashboardBenchmarkSortKey;
  onToggleQuestionPreset(id: string): void;
  onToggleManagedPreset(id: string): void;
  onRepetitionsChange(value: number): void;
  onSpecOverrideLabelChange(value: string): void;
  onStartBenchmark(): Promise<void>;
  onCancelBenchmark(sessionId: string): Promise<void>;
  onSortChange(sortKey: DashboardBenchmarkSortKey): void;
  onUpdateAttemptGrade(attemptId: string, outputQualityScore: number | null, toolUseQualityScore: number | null, reviewNotes: string | null): Promise<void>;
};

function formatNumber(value: number | null | undefined, digits = 2): string {
  return Number.isFinite(value) ? Number(value).toFixed(digits) : 'Ungraded';
}

function formatOptionalMs(value: number | null): string {
  return Number.isFinite(value) ? `${Math.round(Number(value))} ms` : '-';
}

function isSelected(id: string, selectedIds: string[]): boolean {
  return selectedIds.includes(id);
}

function sortableButton(label: string, sortKey: DashboardBenchmarkSortKey, activeSortKey: DashboardBenchmarkSortKey, onSortChange: (sortKey: DashboardBenchmarkSortKey) => void) {
  return (
    <button
      type="button"
      className={activeSortKey === sortKey ? 'filter-pill active' : 'filter-pill'}
      onClick={() => onSortChange(sortKey)}
    >
      {label}
    </button>
  );
}

export function BenchmarkTab(props: BenchmarkTabProps) {
  const {
    questionPresets,
    sessions,
    selectedSession,
    attempts,
    liveLogLines,
    managedPresets,
    selectedQuestionPresetIds,
    selectedManagedPresetIds,
    repetitions,
    specOverrideLabel,
    loading,
    error,
    starting,
    cancelling,
    sortKey,
    onToggleQuestionPreset,
    onToggleManagedPreset,
    onRepetitionsChange,
    onSpecOverrideLabelChange,
    onStartBenchmark,
    onCancelBenchmark,
    onSortChange,
    onUpdateAttemptGrade,
  } = props;

  const activeSession = selectedSession || sessions[0] || null;
  const selectedAttempt = attempts.find((attempt) => attempt.status === 'running') || attempts[0] || null;

  return (
    <section className="panel-grid benchmark-tab">
      <aside className="panel">
        <header>
          <h2>Benchmark</h2>
          {loading ? <p className="hint">Loading benchmark data...</p> : null}
          {error ? <p className="error">{error}</p> : null}
        </header>

        <section className="detail-card">
          <h3>Question Presets</h3>
          <div className="filters">
            {questionPresets.map((preset) => (
              <label key={preset.id} className="filter-pill">
                <input
                  type="checkbox"
                  checked={isSelected(preset.id, selectedQuestionPresetIds)}
                  onChange={() => onToggleQuestionPreset(preset.id)}
                />
                {preset.title}
                <span className="hint">{preset.taskKind}</span>
              </label>
            ))}
          </div>
        </section>

        <section className="detail-card">
          <h3>Run Builder</h3>
          <label>
            Repetitions
            <input
              type="number"
              min={1}
              max={100}
              value={repetitions}
              onChange={(event) => onRepetitionsChange(Number(event.currentTarget.value))}
            />
          </label>
          <label>
            Spec override label
            <input
              type="text"
              value={specOverrideLabel}
              onChange={(event) => onSpecOverrideLabelChange(event.currentTarget.value)}
            />
          </label>
          <div className="filters">
            {managedPresets.map((preset) => (
              <label key={preset.id} className="filter-pill">
                <input
                  type="checkbox"
                  checked={isSelected(preset.id, selectedManagedPresetIds)}
                  onChange={() => onToggleManagedPreset(preset.id)}
                />
                {preset.label}
              </label>
            ))}
          </div>
          <button type="button" disabled={starting} onClick={() => { void onStartBenchmark(); }}>
            {starting ? 'Starting...' : 'Start Benchmark'}
          </button>
          {activeSession?.status === 'running' ? (
            <button type="button" disabled={cancelling} onClick={() => { void onCancelBenchmark(activeSession.id); }}>
              {cancelling ? 'Cancelling...' : 'Cancel Benchmark'}
            </button>
          ) : null}
        </section>

        {activeSession ? (
          <section className="detail-card">
            <h3>Active Session</h3>
            <p>Status: {activeSession.status}</p>
            <p>Cases: {activeSession.caseCount}</p>
            <p>Repetitions: {activeSession.repetitions}</p>
            <p>Restore: {activeSession.restoreStatus}</p>
            {activeSession.restoreError ? <p className="error">{activeSession.restoreError}</p> : null}
          </section>
        ) : null}
      </aside>

      <main className="panel">
        <section className="detail-card">
          <h3>Live Logs</h3>
          <p className="hint">{selectedAttempt ? selectedAttempt.promptTitle : 'No attempt selected'}</p>
          <pre>{liveLogLines.length > 0 ? liveLogLines.join('\n') : 'Waiting for benchmark output...'}</pre>
        </section>

        <section className="detail-card">
          <h3>Results</h3>
          <div className="filter-pill-row">
            {sortableButton('Overall Completion Speed', 'completionSpeed', sortKey, onSortChange)}
            {sortableButton('Token Speed', 'generationTokensPerSecond', sortKey, onSortChange)}
            {sortableButton('Acceptance', 'acceptanceRate', sortKey, onSortChange)}
            {sortableButton('Output Quality', 'outputQualityScore', sortKey, onSortChange)}
            {sortableButton('Tool Use Quality', 'toolUseQualityScore', sortKey, onSortChange)}
            {sortableButton('Failures', 'failureCount', sortKey, onSortChange)}
            {sortableButton('Sample Count', 'sampleCount', sortKey, onSortChange)}
          </div>
          <table>
            <thead>
              <tr>
                <th>Case</th>
                <th>Question</th>
                <th>Status</th>
                <th>Completion</th>
                <th>Token Speed</th>
                <th>Acceptance</th>
                <th>Output Quality</th>
                <th>Tool Use Quality</th>
                <th>Grade</th>
              </tr>
            </thead>
            <tbody>
              {attempts.map((attempt) => (
                <tr key={attempt.id}>
                  <td>{attempt.caseLabel}</td>
                  <td>{attempt.promptTitle}</td>
                  <td>{attempt.status}</td>
                  <td>{formatOptionalMs(attempt.durationMs)}</td>
                  <td>{formatNumber(attempt.generationTokensPerSecond)}</td>
                  <td>{formatNumber(attempt.acceptanceRate)}</td>
                  <td>{attempt.outputQualityScore === null ? 'Ungraded' : attempt.outputQualityScore}</td>
                  <td>{attempt.toolUseQualityScore === null ? 'Ungraded' : attempt.toolUseQualityScore}</td>
                  <td>
                    <button
                      type="button"
                      disabled={attempt.status !== 'completed'}
                      onClick={() => { void onUpdateAttemptGrade(attempt.id, attempt.outputQualityScore, attempt.toolUseQualityScore, attempt.reviewNotes); }}
                    >
                      Save Grade
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </main>
    </section>
  );
}
