import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  selectInitialPlanRepoRoot,
  selectPresetMaxTurnsText,
  usePlanInputs,
} from '../../src/hooks/usePlanInputs';
import type { ChatSession, DashboardPreset } from '../../src/types';

const SESSION: ChatSession = {
  id: 's1',
  title: 'Session',
  model: null,
  contextWindowTokens: 100,
  condensedSummary: '',
  createdAtUtc: '2026-06-03T12:00:00.000Z',
  updatedAtUtc: '2026-06-03T12:00:00.000Z',
  messages: [],
};

const PRESET: DashboardPreset = {
  id: 'p1',
  label: 'Preset',
  description: '',
  presetKind: 'repo-search',
  operationMode: 'read-only',
  executionFamily: 'repo-search',
  promptPrefix: '',
  allowedTools: [],
  surfaces: ['web'],
  useForSummary: false,
  builtin: false,
  deletable: true,
  includeAgentsMd: true,
  includeRepoFileListing: true,
  repoRootRequired: false,
  maxTurns: 30,
};

test('selectInitialPlanRepoRoot returns the session planRepoRoot or empty string', () => {
  assert.equal(selectInitialPlanRepoRoot(null), '');
  assert.equal(selectInitialPlanRepoRoot({ ...SESSION, planRepoRoot: undefined }), '');
  assert.equal(selectInitialPlanRepoRoot({ ...SESSION, planRepoRoot: 'C:\\repo' }), 'C:\\repo');
});

test('selectPresetMaxTurnsText falls back when preset is null', () => {
  assert.equal(selectPresetMaxTurnsText(null, '45'), '45');
});

test('selectPresetMaxTurnsText falls back when preset.maxTurns is null', () => {
  assert.equal(selectPresetMaxTurnsText({ ...PRESET, maxTurns: null }, '45'), '45');
});

test('selectPresetMaxTurnsText stringifies the preset max turns when present', () => {
  assert.equal(selectPresetMaxTurnsText({ ...PRESET, maxTurns: 12 }, '45'), '12');
});

test('usePlanInputs seeds inputs from session and preset on initial render', () => {
  function Probe(): React.JSX.Element {
    const inputs = usePlanInputs({
      selectedSession: { ...SESSION, planRepoRoot: 'C:\\repo' },
      selectedChatPreset: { ...PRESET, maxTurns: 12 },
    });
    return React.createElement('output', {
      dangerouslySetInnerHTML: {
        __html: JSON.stringify({
          planRepoRootInput: inputs.planRepoRootInput,
          planMaxTurnsInput: inputs.planMaxTurnsInput,
        }),
      },
    });
  }
  const markup = renderToStaticMarkup(React.createElement(Probe));
  assert.match(markup, /"planRepoRootInput":"C:\\\\repo"/);
  assert.match(markup, /"planMaxTurnsInput":"12"/);
});

test('usePlanInputs falls back to default max turns when preset has none', () => {
  function Probe(): React.JSX.Element {
    const inputs = usePlanInputs({
      selectedSession: null,
      selectedChatPreset: null,
    });
    return React.createElement('output', null, inputs.planMaxTurnsInput);
  }
  const markup = renderToStaticMarkup(React.createElement(Probe));
  assert.match(markup, /<output>45<\/output>/);
});
