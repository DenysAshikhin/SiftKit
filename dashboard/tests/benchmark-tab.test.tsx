import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { BenchmarkTab } from '../src/tabs/BenchmarkTab';
import type {
  DashboardBenchmarkAttempt,
  DashboardBenchmarkQuestionPreset,
  DashboardBenchmarkSession,
} from '../src/types';
import { MANAGED_PRESET } from './fixtures.js';

const PROMPT = {
  id: 'prompt-1', title: 'Trace repo-search', taskKind: 'repo-search',
  prompt: 'Trace repo-search execution.', enabled: true,
  createdAtUtc: '2026-05-13T12:00:00.000Z', updatedAtUtc: '2026-05-13T12:00:00.000Z',
} satisfies DashboardBenchmarkQuestionPreset;

const SESSION = {
  id: 'session-1', status: 'completed', questionPresetCount: 1, caseCount: 1, repetitions: 2,
  currentCaseIndex: 0, currentPromptIndex: 0, currentRepeatIndex: 1,
  restoreStatus: 'completed', restoreError: null, originalConfigJson: '{}',
  startedAtUtc: '2026-05-13T12:00:00.000Z', completedAtUtc: '2026-05-13T12:05:00.000Z', updatedAtUtc: '2026-05-13T12:05:00.000Z',
} satisfies DashboardBenchmarkSession;

const ATTEMPT = {
  id: 'attempt-1', sessionId: SESSION.id, caseId: 'case-1', questionPresetId: PROMPT.id,
  taskKind: 'repo-search', promptTitle: PROMPT.title, prompt: PROMPT.prompt, caseLabel: 'Managed / n24-m64',
  managedPresetId: 'managed', managedPresetLabel: 'Managed', caseIndex: 0, promptIndex: 0, repeatIndex: 0,
  status: 'completed', outputText: 'Found repo-search execution.', error: null, runId: 'run-1', managedRunId: 'managed-run-1',
  durationMs: 1200, promptTokensPerSecond: 100, generationTokensPerSecond: 42, acceptanceRate: 0.5,
  outputTokens: 50, thinkingTokens: 5, speculativeAcceptedTokens: 10, speculativeGeneratedTokens: 20,
  outputQualityScore: null, toolUseQualityScore: 8, reviewNotes: null, reviewedBy: null, reviewedAtUtc: null,
  startedAtUtc: '2026-05-13T12:00:00.000Z', completedAtUtc: '2026-05-13T12:00:02.000Z', updatedAtUtc: '2026-05-13T12:00:02.000Z',
} satisfies DashboardBenchmarkAttempt;

test('benchmark tab renders stat tiles above the run builder, logs, and results', () => {
  const markup = renderToStaticMarkup(
    <BenchmarkTab
      questionPresets={[PROMPT]}
      sessions={[SESSION]}
      selectedSession={SESSION}
      attempts={[ATTEMPT]}
      liveLogLines={['starting attempt', 'finished attempt']}
      managedPresets={[MANAGED_PRESET]}
      selectedQuestionPresetIds={[PROMPT.id]}
      selectedManagedPresetIds={[MANAGED_PRESET.id]}
      repetitions={2}
      specOverrideLabel="n24-m64"
      loading={false}
      error={null}
      starting={false}
      cancelling={false}
      sortKey="generationTokensPerSecond"
      onToggleQuestionPreset={() => {}}
      onToggleManagedPreset={() => {}}
      onRepetitionsChange={() => {}}
      onSpecOverrideLabelChange={() => {}}
      onStartBenchmark={async () => {}}
      onCancelBenchmark={async () => {}}
      onSortChange={() => {}}
      onSelectSession={() => {}}
      onUpdateAttemptGrade={async () => {}}
    />,
  );

  assert.match(markup, /class="tiles"/);
  const tileCount = markup.match(/class="tile"/g)?.length ?? 0;
  assert.ok(tileCount >= 4, `expected >= 4 tiles, got ${tileCount}`);
  assert.match(markup, /Last session/);
  assert.match(markup, /Cases passed/);
  assert.match(markup, /Prompt speed/);
  assert.match(markup, /Generation speed/);
  assert.match(markup, /tok\/s/);

  assert.match(markup, /Question Presets/);
  assert.match(markup, /Trace repo-search/);
  assert.match(markup, /Run Builder/);
  assert.match(markup, /Live Logs/);
  assert.match(markup, /Token Speed/);
  assert.match(markup, /Ungraded/);
  assert.match(markup, /class="mtable"/);
});
