import React from 'react';
import { StatusDot } from '../components/StatusDot';
import type {
  DashboardBenchmarkAttempt,
  DashboardBenchmarkQuestionPreset,
  DashboardBenchmarkSession,
  DashboardBenchmarkSortKey,
  DashboardModelRuntimePreset,
} from '../types';

export type BenchmarkTabProps = {
  questionPresets: DashboardBenchmarkQuestionPreset[];
  sessions: DashboardBenchmarkSession[];
  selectedSession: DashboardBenchmarkSession | null;
  attempts: DashboardBenchmarkAttempt[];
  liveLogLines: string[];
  managedPresets: DashboardModelRuntimePreset[];
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
  onSelectSession(sessionId: string): void;
  onUpdateAttemptGrade(attemptId: string, outputQualityScore: number | null, toolUseQualityScore: number | null, reviewNotes: string | null): Promise<void>;
};

export type BenchmarkTiles = {
  lastSession: string;
  casesPassed: number;
  casesTotal: number;
  promptTokensPerSecond: number | null;
  generationTokensPerSecond: number | null;
};

function averageNonNull(values: (number | null)[]): number | null {
  const present = values.filter((value): value is number => Number.isFinite(value));
  if (present.length === 0) {
    return null;
  }
  return present.reduce((sum, value) => sum + value, 0) / present.length;
}

export function deriveBenchmarkTiles(
  session: DashboardBenchmarkSession | null,
  attempts: DashboardBenchmarkAttempt[],
): BenchmarkTiles {
  const lastSession = attempts[0]?.managedPresetLabel ?? (session ? session.id.slice(0, 8) : '-');
  return {
    lastSession,
    casesPassed: attempts.filter((attempt) => attempt.status === 'completed').length,
    casesTotal: attempts.length,
    promptTokensPerSecond: averageNonNull(attempts.map((attempt) => attempt.promptTokensPerSecond)),
    generationTokensPerSecond: averageNonNull(attempts.map((attempt) => attempt.generationTokensPerSecond)),
  };
}

function formatSessionLabel(session: DashboardBenchmarkSession): string {
  const started = session.startedAtUtc ? new Date(session.startedAtUtc).toLocaleString() : session.id.slice(0, 8);
  return `${started} — ${session.status} (${session.caseCount} cases × ${session.repetitions})`;
}

function formatScore(value: number | null | undefined, digits = 2): string {
  return Number.isFinite(value) ? Number(value).toFixed(digits) : 'Ungraded';
}

function formatOptionalMs(value: number | null): string {
  return Number.isFinite(value) ? `${Math.round(Number(value))} ms` : '-';
}

function formatRate(value: number | null, digits: number): string {
  return value === null ? '-' : value.toFixed(digits);
}

function isSelected(id: string, selectedIds: string[]): boolean {
  return selectedIds.includes(id);
}

const SORT_OPTIONS: { key: DashboardBenchmarkSortKey; label: string }[] = [
  { key: 'completionSpeed', label: 'Overall Completion Speed' },
  { key: 'generationTokensPerSecond', label: 'Token Speed' },
  { key: 'acceptanceRate', label: 'Acceptance' },
  { key: 'outputQualityScore', label: 'Output Quality' },
  { key: 'toolUseQualityScore', label: 'Tool Use Quality' },
  { key: 'failureCount', label: 'Failures' },
  { key: 'sampleCount', label: 'Sample Count' },
];

export function BenchmarkTab({
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
  onSelectSession,
  onUpdateAttemptGrade,
}: BenchmarkTabProps) {
  const activeSession = selectedSession || sessions[0] || null;
  const selectedAttempt = attempts.find((attempt) => attempt.status === 'running') || attempts[0] || null;
  const tiles = deriveBenchmarkTiles(activeSession, attempts);

  return (
    <div className="bench">
      {loading ? <p className="hint">Loading benchmark data…</p> : null}
      {error ? <p className="error">{error}</p> : null}

      <div className="tiles">
        <div className="tile"><label>Last session</label><span className="n">{tiles.lastSession}</span></div>
        <div className="tile"><label>Cases passed</label><span className="n">{tiles.casesPassed}<small> / {tiles.casesTotal}</small></span></div>
        <div className="tile"><label>Prompt speed</label><span className="n">{formatRate(tiles.promptTokensPerSecond, 0)}<small> tok/s</small></span></div>
        <div className="tile"><label>Generation speed</label><span className="n">{formatRate(tiles.generationTokensPerSecond, 1)}<small> tok/s</small></span></div>
      </div>

      <div className="graph-card">
        <h3>Question Presets</h3>
        <div className="bench-opts">
          {questionPresets.map((preset) => (
            <label key={preset.id} className="bench-opt">
              <input type="checkbox" checked={isSelected(preset.id, selectedQuestionPresetIds)} onChange={() => onToggleQuestionPreset(preset.id)} />
              {preset.title}
              <span className="hint">{preset.taskKind}</span>
            </label>
          ))}
        </div>
      </div>

      <div className="graph-card">
        <h3>Run Builder</h3>
        <label className="bench-field">
          Repetitions
          <input type="number" min={1} max={100} value={repetitions} onChange={(event) => onRepetitionsChange(Number(event.currentTarget.value))} />
        </label>
        <label className="bench-field">
          Spec override label
          <input type="text" value={specOverrideLabel} onChange={(event) => onSpecOverrideLabelChange(event.currentTarget.value)} />
        </label>
        <div className="bench-opts">
          {managedPresets.map((preset) => (
            <label key={preset.id} className="bench-opt">
              <input type="checkbox" checked={isSelected(preset.id, selectedManagedPresetIds)} onChange={() => onToggleManagedPreset(preset.id)} />
              {preset.label}
            </label>
          ))}
        </div>
        <div className="bench-actions">
          <button type="button" className="save" disabled={starting} onClick={() => { void onStartBenchmark(); }}>
            {starting ? 'Starting…' : 'Start Benchmark'}
          </button>
          {activeSession?.status === 'running' ? (
            <button type="button" className="ghost-btn" disabled={cancelling} onClick={() => { void onCancelBenchmark(activeSession.id); }}>
              {cancelling ? 'Cancelling…' : 'Cancel Benchmark'}
            </button>
          ) : null}
        </div>
      </div>

      {sessions.length > 0 ? (
        <div className="graph-card">
          <h3>Past Sessions</h3>
          <label className="bench-field">
            View session
            <select value={activeSession?.id ?? ''} onChange={(event) => onSelectSession(event.currentTarget.value)}>
              {sessions.map((session) => (
                <option key={session.id} value={session.id}>{formatSessionLabel(session)}</option>
              ))}
            </select>
          </label>
        </div>
      ) : null}

      {activeSession ? (
        <div className="graph-card">
          <h3>Active Session</h3>
          <div className="meta-line">
            <span>status {activeSession.status}</span>
            <span>cases {activeSession.caseCount}</span>
            <span>reps {activeSession.repetitions}</span>
            <span>restore {activeSession.restoreStatus}</span>
          </div>
          {activeSession.restoreError ? <p className="error">{activeSession.restoreError}</p> : null}
        </div>
      ) : null}

      <div className="graph-card">
        <h3>Live Logs</h3>
        <p className="hint">{selectedAttempt ? selectedAttempt.promptTitle : 'No attempt selected'}</p>
        <pre className="mono">{liveLogLines.length > 0 ? liveLogLines.join('\n') : 'Waiting for benchmark output…'}</pre>
      </div>

      <div className="graph-card">
        <h3>Results</h3>
        <div className="chips">
          {SORT_OPTIONS.map((option) => (
            <button
              key={option.key}
              type="button"
              className={sortKey === option.key ? 'chip on' : 'chip'}
              onClick={() => onSortChange(option.key)}
            >
              {option.label}
            </button>
          ))}
        </div>
        <table className="mtable">
          <thead>
            <tr>
              <th>Case</th>
              <th>Question</th>
              <th>Status</th>
              <th className="num">Completion</th>
              <th className="num">Token Speed</th>
              <th className="num">Acceptance</th>
              <th className="num">Output Quality</th>
              <th className="num">Tool Use Quality</th>
              <th>Notes</th>
              <th>Grade</th>
            </tr>
          </thead>
          <tbody>
            {attempts.map((attempt) => (
              <tr key={attempt.id}>
                <td>{attempt.caseLabel}</td>
                <td>{attempt.promptTitle}</td>
                <td><StatusDot status={attempt.status} /></td>
                <td className="num">{formatOptionalMs(attempt.durationMs)}</td>
                <td className="num">{formatScore(attempt.generationTokensPerSecond)}</td>
                <td className="num">{formatScore(attempt.acceptanceRate)}</td>
                <td className="num">{attempt.outputQualityScore === null ? 'Ungraded' : attempt.outputQualityScore}</td>
                <td className="num">{attempt.toolUseQualityScore === null ? 'Ungraded' : attempt.toolUseQualityScore}</td>
                <td className="benchmark-notes-cell">{attempt.reviewNotes ?? ''}</td>
                <td>
                  <button
                    type="button"
                    className="ghost-btn"
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
      </div>
    </div>
  );
}
