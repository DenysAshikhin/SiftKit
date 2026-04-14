import test from 'node:test';
import assert from 'node:assert/strict';

import { resolvePresetAllowedTools } from '../dist/presets.js';
import { buildPlannerToolDefinitions, executePlannerTool } from '../dist/summary/planner/tools.js';
import { runRepoSearch } from '../dist/repo-search/engine.js';
import { getDefaultConfig } from '../dist/status-server/config-store.js';

test('summary planner tool definitions respect the preset allowlist', () => {
  const definitions = buildPlannerToolDefinitions(['find_text']);
  assert.deepEqual(definitions.map((definition) => definition.function.name), ['find_text']);
});

test('summary planner tool execution rejects disallowed tools', () => {
  assert.throws(
    () => executePlannerTool('alpha\nbeta', {
      action: 'tool',
      tool_name: 'read_lines',
      args: { startLine: 1, endLine: 1 },
    }, ['find_text']),
    /not allowed by the active preset/u,
  );
});

test('repo-search rejects presets that disable the repo command tool', async () => {
  await assert.rejects(
    () => runRepoSearch({
      repoRoot: process.cwd(),
      config: getDefaultConfig(),
      model: 'mock-model',
      availableModels: ['mock-model'],
      mockResponses: [],
      allowedTools: ['find_text'],
      taskPrompt: 'find planner tools',
    }),
    /run_repo_cmd/u,
  );
});

test('effective tool allowlist intersects operation-mode policy with preset whitelist', () => {
  assert.deepEqual(
    resolvePresetAllowedTools({
      operationMode: 'summary',
      allowedTools: ['find_text', 'run_repo_cmd'],
    }, {
      summary: ['find_text', 'read_lines', 'json_filter'],
      'read-only': ['run_repo_cmd'],
      full: [],
    }),
    ['find_text'],
  );
});
