import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RunsTab, type RunsTabProps } from '../src/tabs/RunsTab';
import type { RunRecord, RunDetailResponse } from '../src/types';

function makeRun(overrides: Partial<RunRecord>): RunRecord {
  return {
    id: 'run_1', kind: 'repo_search', status: 'completed',
    startedAtUtc: '2026-07-19T11:42:07Z', finishedAtUtc: '2026-07-19T11:44:21Z',
    title: 'Locate EXL3 preset controls', model: null, backend: null,
    inputTokens: null, outputTokens: null, thinkingTokens: null,
    toolTokens: null, promptCacheTokens: null, promptEvalTokens: null,
    promptEvalDurationMs: null, generationDurationMs: null,
    speculativeAcceptedTokens: null, speculativeGeneratedTokens: null,
    durationMs: 134000, providerDurationMs: null, wallDurationMs: null,
    rawPaths: {},
    ...overrides,
  };
}

const RUN = makeRun({});
const DETAIL: RunDetailResponse = { run: RUN, events: [] };

const PROPS: RunsTabProps = {
  search: '',
  statusFilter: '',
  kindFilter: '',
  runsLoading: false,
  runsError: null,
  groupedRuns: { summary: [], repo_search: [RUN, makeRun({ id: 'run_2', title: 'Trace Tabby restart flow' })], planner: [], chat: [], other: [] },
  selectedRunId: 'run_1',
  selectedRunDetail: DETAIL,
  isRepoSearchRunSelected: false,
  repoSearchSimpleFlow: false,
  repoSearchChatSteps: [],
  onChangeSearch: () => {},
  onOpenRunDeleteModal: () => {},
  onChangeStatusFilter: () => {},
  onToggleKindFilter: () => {},
  onSelectRun: () => {},
  onChangeRepoSearchSimpleFlow: () => {},
};

test('runs tab renders list pane, one chip row, grouped rows and detail meta-line', () => {
  const markup = renderToStaticMarkup(<RunsTab {...PROPS} />);
  assert.match(markup, /class="list-pane"/);
  assert.match(markup, /class="chips"/);
  for (const label of ['All', 'Summary', 'Repo Search', 'Planner', 'Chat', 'Done', 'Failed', 'Running']) {
    assert.match(markup, new RegExp(label));
  }
  assert.match(markup, /Repo Search · 2/);
  assert.match(markup, /class="dot ok"/);
  assert.match(markup, /completed/);
  assert.match(markup, /class="meta-line"/);
  assert.doesNotMatch(markup, /run-chip/);
  assert.doesNotMatch(markup, /panel-grid/);
});
