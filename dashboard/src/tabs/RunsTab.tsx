import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { RUN_LOG_TYPE_PRESETS, normalizeRunLogTypeFilter } from '../run-log-admin';
import { StatusDot } from '../components/StatusDot';
import { FilterChips, type FilterChipItem } from '../components/FilterChips';
import {
  extractRunFinalOutput,
  formatDate,
  formatDurationHms,
  formatRunEventPayload,
  formatShortTime,
  normalizeFinalOutputText,
  runGroupLabel,
} from '../lib/format';
import type { RepoSearchChatStep } from '../lib/chat-steps';
import type { RunDetailResponse, RunGroupFilter, RunRecord } from '../types';

type RunGroupKey = Exclude<RunGroupFilter, ''>;
const RUN_GROUP_KEYS = ['summary', 'repo_search', 'planner', 'chat', 'other'] as const satisfies readonly RunGroupKey[];
const STATUS_CHIPS = [
  { value: 'completed', label: 'Done' },
  { value: 'failed', label: 'Failed' },
  { value: 'running', label: 'Running' },
] as const;

export type RunsTabProps = {
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
  onChangeStatusFilter,
  onToggleKindFilter,
  onSelectRun,
  onChangeRepoSearchSimpleFlow,
}: RunsTabProps) {
  const chipItems: FilterChipItem[] = [
    ...RUN_LOG_TYPE_PRESETS.map((preset) => ({
      value: `kind:${preset.value}`,
      label: preset.label,
      active: kindFilter === preset.value,
    })),
    ...STATUS_CHIPS.map((chip) => ({
      value: `status:${chip.value}`,
      label: chip.label,
      active: statusFilter === chip.value,
    })),
  ];

  function onToggleChip(value: string): void {
    if (value.startsWith('kind:')) {
      onToggleKindFilter(normalizeRunLogTypeFilter(value.slice('kind:'.length)));
      return;
    }
    const nextStatus = value.slice('status:'.length);
    onChangeStatusFilter(statusFilter === nextStatus ? '' : nextStatus);
  }

  return (
    <>
      <div className="list-pane">
        <div className="list-tools">
          <label className="search">
            ⌕
            <input placeholder="Search runs…" value={search} onChange={(event) => onChangeSearch(event.target.value)} />
          </label>
          <FilterChips items={chipItems} onToggle={onToggleChip} />
        </div>
        <div className="runs">
          {runsLoading && <p className="hint">Loading runs…</p>}
          {runsError && <p className="error">{runsError}</p>}
          {RUN_GROUP_KEYS.map((group) => {
            const items = groupedRuns[group];
            if (items.length === 0) {
              return null;
            }
            return (
              <React.Fragment key={group}>
                <div className="rgroup">{runGroupLabel(group)} · {items.length}</div>
                {items.map((run) => (
                  <div
                    key={run.id}
                    className={selectedRunId === run.id ? 'run sel' : 'run'}
                    role="button"
                    tabIndex={0}
                    onClick={() => onSelectRun(run.id)}
                  >
                    <span className="t">{run.title}</span>
                    <span className="m">
                      <StatusDot status={run.status} /> · {formatDurationHms(run.durationMs)} · {formatShortTime(run.startedAtUtc)}
                    </span>
                  </div>
                ))}
              </React.Fragment>
            );
          })}
        </div>
      </div>
      <div className="detail">
        {selectedRunDetail ? (
          <>
            <h2>{selectedRunDetail.run.title}</h2>
            <div className="meta-line">
              <span>{selectedRunDetail.run.id}</span>
              <span>{selectedRunDetail.run.kind}</span>
              <span>{selectedRunDetail.run.status}</span>
              <span>started {formatShortTime(selectedRunDetail.run.startedAtUtc)}</span>
              <span>{formatDurationHms(selectedRunDetail.run.durationMs)}</span>
            </div>
            {(() => {
              const finalOutput = extractRunFinalOutput(selectedRunDetail);
              if (!finalOutput) {
                return null;
              }
              return (
                <div className="card final">
                  <header><b>Final Output</b></header>
                  <div className="cbody markdown-body">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                      {normalizeFinalOutputText(finalOutput)}
                    </ReactMarkdown>
                  </div>
                </div>
              );
            })()}
            {isRepoSearchRunSelected ? (
              <div className="run-view-toggle-row">
                <button
                  type="button"
                  className={repoSearchSimpleFlow ? 'chip on' : 'chip'}
                  onClick={() => onChangeRepoSearchSimpleFlow(true)}
                >
                  Simplified Flow
                </button>
                <button
                  type="button"
                  className={!repoSearchSimpleFlow ? 'chip on' : 'chip'}
                  onClick={() => onChangeRepoSearchSimpleFlow(false)}
                >
                  Raw Events
                </button>
              </div>
            ) : null}
            {isRepoSearchRunSelected && repoSearchSimpleFlow ? (
              repoSearchChatSteps.length > 0 ? (
                repoSearchChatSteps.map((step, index) => (
                  <div key={step.id} className="card">
                    <header><b>Step {index + 1}</b><span>{step.contextUsed || '-'}</span></header>
                    <div className="cbody simple-flow-body">
                      {step.prompt ? (
                        <section className="simple-flow-section">
                          <h4>Prompt</h4>
                          <pre className="mono">{step.prompt}</pre>
                        </section>
                      ) : null}
                      <section className="simple-flow-section">
                        <h4>Command</h4>
                        <pre className="mono simple-flow-command">{step.command}</pre>
                      </section>
                      <section className="simple-flow-section">
                        <h4>Output</h4>
                        <pre className="mono">{step.output}</pre>
                      </section>
                    </div>
                  </div>
                ))
              ) : (
                <p className="hint">No simplified steps found. Switch to Raw Events for full transcript details.</p>
              )
            ) : (
              selectedRunDetail.events.map((event, index) => (
                <div key={`${event.kind}-${index}`} className="card">
                  <header><b>{event.kind}</b><span>{event.at ? formatDate(event.at) : ''}</span></header>
                  <div className="cbody markdown-body">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                      {formatRunEventPayload(event)}
                    </ReactMarkdown>
                  </div>
                </div>
              ))
            )}
          </>
        ) : (
          <p className="hint">Select a run to inspect details.</p>
        )}
      </div>
    </>
  );
}
