import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { RUN_LOG_TYPE_PRESETS } from '../run-log-admin';
import {
  classifyRunGroup,
  extractRunFinalOutput,
  formatDate,
  formatDurationHms,
  formatRunEventPayload,
  normalizeFinalOutputText,
  runGroupLabel,
} from '../lib/format';
import type { RepoSearchChatStep } from '../lib/chat-steps';
import type { RunDetailResponse, RunGroupFilter, RunRecord } from '../types';

type RunGroupKey = Exclude<RunGroupFilter, ''>;

type RunsTabProps = {
  search: string;
  statusFilter: string;
  kindFilter: RunGroupFilter;
  runsLoading: boolean;
  runsError: string | null;
  groupedRuns: Record<RunGroupKey, RunRecord[]>;
  selectedRunId: string;
  selectedRunDetail: RunDetailResponse | null;
  isRepoSearchRunSelected: boolean;
  repoSearchSimpleFlow: boolean;
  repoSearchChatSteps: RepoSearchChatStep[];
  onChangeSearch(value: string): void;
  onOpenRunDeleteModal(): void;
  onChangeStatusFilter(value: string): void;
  onToggleKindFilter(value: RunGroupFilter): void;
  onSelectRun(runId: string): void;
  onChangeRepoSearchSimpleFlow(next: boolean): void;
};

export function RunsTab({
  search,
  statusFilter,
  kindFilter,
  runsLoading,
  runsError,
  groupedRuns,
  selectedRunId,
  selectedRunDetail,
  isRepoSearchRunSelected,
  repoSearchSimpleFlow,
  repoSearchChatSteps,
  onChangeSearch,
  onOpenRunDeleteModal,
  onChangeStatusFilter,
  onToggleKindFilter,
  onSelectRun,
  onChangeRepoSearchSimpleFlow,
}: RunsTabProps) {
  return (
    <section className="panel-grid">
      <section className="panel">
        <div className="filters">
          <div className="run-filter-toolbar">
            <input placeholder="Search runs" value={search} onChange={(event) => onChangeSearch(event.target.value)} />
            <button type="button" className="run-delete-button" onClick={onOpenRunDeleteModal}>
              Delete Logs
            </button>
          </div>
          <input placeholder="Status filter" value={statusFilter} onChange={(event) => onChangeStatusFilter(event.target.value)} />
          <div className="filter-pill-row">
            <span className="filter-pill-label">Type</span>
            {RUN_LOG_TYPE_PRESETS.map((preset) => (
              <button
                key={preset.label}
                type="button"
                className={`filter-pill kind ${preset.tone} ${kindFilter === preset.value ? 'active' : ''}`}
                onClick={() => onToggleKindFilter(preset.value)}
              >
                {preset.label}
              </button>
            ))}
          </div>
          <div className="filter-pill-row">
            <span className="filter-pill-label">Status</span>
            <button
              type="button"
              className={`filter-pill status completed ${statusFilter === 'completed' ? 'active' : ''}`}
              onClick={() => onChangeStatusFilter(statusFilter === 'completed' ? '' : 'completed')}
            >
              Completed
            </button>
            <button
              type="button"
              className={`filter-pill status failed ${statusFilter === 'failed' ? 'active' : ''}`}
              onClick={() => onChangeStatusFilter(statusFilter === 'failed' ? '' : 'failed')}
            >
              Failed
            </button>
            <button
              type="button"
              className={`filter-pill status running ${statusFilter === 'running' ? 'active' : ''}`}
              onClick={() => onChangeStatusFilter(statusFilter === 'running' ? '' : 'running')}
            >
              Running
            </button>
          </div>
        </div>
        {runsLoading && <p className="hint">Loading runs...</p>}
        {runsError && <p className="error">{runsError}</p>}
        {(Object.keys(groupedRuns) as RunGroupKey[]).map((group) => {
          const items = groupedRuns[group];
          if (items.length === 0) {
            return null;
          }
          return (
            <section key={group} className="run-group">
              <header>{runGroupLabel(group)} ({items.length})</header>
              <ul className="run-list">
                {items.map((run) => (
                  <li key={run.id}>
                    <button className={selectedRunId === run.id ? 'selected' : ''} onClick={() => onSelectRun(run.id)}>
                      <span>{run.title}</span>
                      <span className="run-meta-line">
                        <span className={`run-chip kind ${classifyRunGroup(run.kind)}`}>{run.kind}</span>
                        <span className={`run-chip status ${String(run.status).toLowerCase()}`}>{run.status}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </section>
      <section className="panel">
        {selectedRunDetail ? (
          <>
            <h2>{selectedRunDetail.run.title}</h2>
            <p className="hint">
              {selectedRunDetail.run.id}
              {' | '}
              <span className={`run-chip kind ${classifyRunGroup(selectedRunDetail.run.kind)}`}>{selectedRunDetail.run.kind}</span>
              {' '}
              <span className={`run-chip status ${String(selectedRunDetail.run.status).toLowerCase()}`}>{selectedRunDetail.run.status}</span>
            </p>
            <p className="hint">Started: {formatDate(selectedRunDetail.run.startedAtUtc)} | Duration: {formatDurationHms(selectedRunDetail.run.durationMs)}</p>
            {(() => {
              const finalOutput = extractRunFinalOutput(selectedRunDetail);
              if (!finalOutput) {
                return null;
              }
              return (
                <details className="detail-card final-output-card" open>
                  <summary>Final Output</summary>
                  <div className="markdown-body">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                      {normalizeFinalOutputText(finalOutput)}
                    </ReactMarkdown>
                  </div>
                </details>
              );
            })()}
            {isRepoSearchRunSelected ? (
              <div className="run-view-toggle-row">
                <button
                  type="button"
                  className={repoSearchSimpleFlow ? 'active' : ''}
                  onClick={() => onChangeRepoSearchSimpleFlow(true)}
                >
                  Simplified Flow
                </button>
                <button
                  type="button"
                  className={!repoSearchSimpleFlow ? 'active' : ''}
                  onClick={() => onChangeRepoSearchSimpleFlow(false)}
                >
                  Raw Events
                </button>
              </div>
            ) : null}
            {isRepoSearchRunSelected && repoSearchSimpleFlow ? (
              repoSearchChatSteps.length > 0 ? (
                repoSearchChatSteps.map((step, index) => (
                  <details key={step.id} className="detail-card simple-flow-card" open={index === 0}>
                    <summary className="simple-flow-summary">
                      <span>Step {index + 1}</span>
                      <span className="simple-flow-summary-meta">{step.contextUsed || '-'}</span>
                    </summary>
                    <div className="simple-flow-body">
                      {step.prompt ? (
                        <section className="simple-flow-section">
                          <h4>Prompt</h4>
                          <pre>{step.prompt}</pre>
                        </section>
                      ) : null}
                      <section className="simple-flow-section">
                        <h4>Command</h4>
                        <pre className="simple-flow-command">{step.command}</pre>
                      </section>
                      <section className="simple-flow-section">
                        <h4>Output</h4>
                        <pre>{step.output}</pre>
                      </section>
                    </div>
                  </details>
                ))
              ) : (
                <p className="hint">No simplified steps found. Switch to Raw Events for full transcript details.</p>
              )
            ) : (
              selectedRunDetail.events.map((event, index) => (
                <details key={`${event.kind}-${index}`} className="detail-card" open={index === 0}>
                  <summary>{event.kind} {event.at ? `| ${formatDate(event.at)}` : ''}</summary>
                  <div className="markdown-body">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                      {formatRunEventPayload(event)}
                    </ReactMarkdown>
                  </div>
                </details>
              ))
            )}
          </>
        ) : (
          <p className="hint">Select a run to inspect details.</p>
        )}
      </section>
    </section>
  );
}
