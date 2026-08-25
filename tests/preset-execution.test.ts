import test from 'node:test';
import assert from 'node:assert/strict';

import { resolvePresetAllowedTools } from '../src/presets.js';
import { executePlannerTool } from '../src/summary/planner/tools.js';
import { buildSummaryPlannerToolDefinitions } from '../src/planner-protocol/summary-tools.js';
import { runRepoSearch } from '../src/repo-search/engine.js';
import { resolveRepoSearchPlannerToolDefinitions } from '../src/repo-search/planner-protocol.js';
import { createEmptyPresetSystemContext } from './helpers/empty-preset-system-context.js';
import { getDefaultConfig } from '../src/status-server/config-store.js';

test('summary planner tool definitions respect the preset allowlist', () => {
  const definitions = buildSummaryPlannerToolDefinitions(['find_text']);
  assert.deepEqual(definitions.map((definition) => definition.function.name), ['find_text', 'finish']);
});

test('summary planner tool execution rejects disallowed tools', () => {
  assert.throws(
    () => executePlannerTool('alpha\nbeta', {
      toolName: 'read_lines',
      args: { startLine: 1, endLine: 1 },
    }, ['find_text']),
    /not allowed by the active preset/u,
  );
});

test('repo-search rejects presets that disable the repo command tool', async () => {
  const plannerToolDefinitions = resolveRepoSearchPlannerToolDefinitions(['find_text']);
  assert.deepEqual(plannerToolDefinitions, []);
  await assert.rejects(
    () => runRepoSearch({
      repoRoot: process.cwd(),
      systemContext: createEmptyPresetSystemContext(),
      taskKind: 'repo-search',
      config: getDefaultConfig(),
      model: 'mock-model',
      availableModels: ['mock-model'],
      mockResponses: [],
      plannerToolDefinitions,
      taskPrompt: 'inspect',
    }),
    /No repo-search planner tools are enabled/u,
  );
});

test('repo-search rejects presets that resolve to an empty allowed-tools list', async () => {
  await assert.rejects(
    () => runRepoSearch({
      repoRoot: process.cwd(),
      systemContext: createEmptyPresetSystemContext(),
      taskKind: 'repo-search',
      config: getDefaultConfig(),
      model: 'mock-model',
      availableModels: ['mock-model'],
      mockResponses: [],
      plannerToolDefinitions: [],
      taskPrompt: 'find planner tools',
    }),
    /No repo-search planner tools are enabled/u,
  );
});

test('effective tool allowlist intersects operation-mode policy with preset whitelist', () => {
  assert.deepEqual(
    resolvePresetAllowedTools({
      operationMode: 'summary',
      allowedTools: ['find_text', 'grep'],
    }, {
      summary: ['find_text', 'read_lines', 'json_filter'],
      'read-only': ['grep'],
      full: [],
    }),
    ['find_text'],
  );
});
