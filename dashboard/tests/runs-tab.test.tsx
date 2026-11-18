import { test } from 'vitest';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RunsTab, type RunsTabProps } from '../src/tabs/RunsTab.tsx';
import type { RunRecord, RunDetailResponse } from '../src/types.ts';
import { groupEngineEvents } from '../src/lib/engine-events.ts';

function makeRun(overrides: Partial<RunRecord>): RunRecord {
  return {
    id: 'run_1', kind: 'repo_search', status: 'completed',
    operationType: null, operationPresetId: null, modelPresetId: null,
    operationPresetJson: null, modelPresetJson: null,
    startedAtUtc: '2026-07-19T11:42:07Z', finishedAtUtc: '2026-07-19T11:44:21Z',
    title: 'Locate EXL3 preset controls', model: null, backend: null,
    inputTokens: null, outputTokens: null, thinkingTokens: null,
    toolTokens: null, promptCacheTokens: null, promptEvalTokens: null,
    promptEvalDurationMs: null, generationDurationMs: null,
    speculativeAcceptedTokens: null, speculativeGeneratedTokens: null, throughput: null,
    durationMs: 134000, providerDurationMs: null, wallDurationMs: null,
    promptCacheBreakCount: 0,
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
  engineGroups: [],
  engineOnly: false,
  selectedEngineGroupKey: '',
  onToggleEngineOnly: () => {},
  onSelectEngineGroup: () => {},
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

const ENGINE_GROUPS = groupEngineEvents([
  { id: 'e2', occurredAtUtc: '2026-11-18T10:00:02Z', kind: 'engine_error', inferenceRunId: 'eng-1', runId: null, turn: null, summary: 'Exception in ASGI application', detail: 'TRACE-TEXT' },
  { id: 'e1', occurredAtUtc: '2026-11-18T10:00:01Z', kind: 'engine_error', inferenceRunId: 'eng-1', runId: null, turn: null, summary: 'Exception in ASGI application', detail: 'older' },
  { id: 'c1', occurredAtUtc: '2026-11-18T09:00:00Z', kind: 'prompt_cache_break', inferenceRunId: null, runId: 'run_2', turn: 4, summary: 'Turn 4 re-prefilled 9,000 tokens; the prompt grew 100', detail: '' },
]);

test('the Engine section lists collapsed groups above the runs and shows a selected group with its run link', () => {
  const markup = renderToStaticMarkup(<RunsTab {...PROPS} engineGroups={ENGINE_GROUPS} selectedEngineGroupKey={ENGINE_GROUPS[0]?.key ?? ''} selectedRunDetail={null} />);
  assert.match(markup, /Engine \(exl3\) · 2/u);
  assert.match(markup, /Exception in ASGI application/u);
  assert.match(markup, /×2/u);
  assert.match(markup, /TRACE-TEXT/u);
  assert.ok(markup.indexOf('Engine (exl3)') < markup.indexOf('Repo Search · 2'));

  const cacheMarkup = renderToStaticMarkup(<RunsTab {...PROPS} engineGroups={ENGINE_GROUPS} selectedEngineGroupKey={ENGINE_GROUPS[1]?.key ?? ''} selectedRunDetail={null} />);
  assert.match(cacheMarkup, /Open run run_2/u);
});

test('the Engine chip shows only the Engine section', () => {
  const markup = renderToStaticMarkup(<RunsTab {...PROPS} engineGroups={ENGINE_GROUPS} engineOnly />);
  assert.match(markup, /Engine \(exl3\) · 2/u);
  assert.doesNotMatch(markup, /Repo Search · 2/u);
});

test('a run with cache breaks shows a badge, and its detail lists each break', () => {
  const broken = makeRun({ promptCacheBreakCount: 2 });
  const detail: RunDetailResponse = { run: broken, events: [
    { kind: 'prompt_cache_break', at: null, payload: { kind: 'prompt_cache_break', turn: 4, promptTokens: 9_100, previousPromptTokens: 9_000, promptEvalTokens: 9_000, promptCacheTokens: null } },
  ] };
  const markup = renderToStaticMarkup(<RunsTab {...PROPS} groupedRuns={{ ...PROPS.groupedRuns, repo_search: [broken] }} selectedRunDetail={detail} />);
  assert.match(markup, /⚠ cache ×2/u);
  assert.match(markup, /Turn 4 re-prefilled 9,000 tokens; the prompt grew 100/u);
});
