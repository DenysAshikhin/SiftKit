import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectPresetRunKind, StatusPresetRunner } from '../src/status-server/preset-runner.js';
import { StatusEngineService } from '../src/status-server/engine-service.js';
import { buildScorecard } from '../src/repo-search/engine.js';
import type { RepoSearchExecutionRequest, RepoSearchExecutionResult } from '../src/repo-search/types.js';
import { getConfigPath, type SiftConfig } from '../src/config/index.js';
import { getDefaultConfigObject } from '../src/config/defaults.js';
import { writeConfig } from '../src/status-server/config-store.js';
import { mockConfig, withTempEnv } from './_runtime-helpers.js';

class CapturingEngineService extends StatusEngineService {
  readonly repoSearchRequests: RepoSearchExecutionRequest[] = [];

  override executeRepoSearch(request: RepoSearchExecutionRequest): Promise<RepoSearchExecutionResult> {
    this.repoSearchRequests.push(request);
    return Promise.resolve({
      requestId: 'preset-runner-test',
      transcriptPath: '',
      artifactPath: '',
      scorecard: buildScorecard({ runId: 'preset-runner-test', model: 'test-model', tasks: [] }),
      turnRecords: [],
    });
  }
}

/** The built-in `chat` preset is web-only, so CLI chat needs a cli-surfaced clone. */
function buildCliChatConfig(reasoning: 'on' | 'off'): SiftConfig {
  const defaults = getDefaultConfigObject();
  const chatPreset = defaults.Presets.find((preset) => preset.id === 'chat');
  if (!chatPreset) {
    throw new Error('Default preset catalog has no chat preset.');
  }
  return mockConfig({
    Presets: [
      ...defaults.Presets,
      { ...chatPreset, id: 'cli-chat', label: 'CLI Chat', surfaces: ['cli'], builtin: false, deletable: true },
    ],
    Server: {
      ModelPresets: {
        ActivePresetId: 'default',
        Presets: [{ id: 'default', label: 'Default', Model: 'test-model', Reasoning: reasoning, IdleAction: 'unload' }],
      },
    },
  });
}

async function runCliChatPreset(reasoning: 'on' | 'off'): Promise<RepoSearchExecutionRequest> {
  return withTempEnv(async () => {
    writeConfig(getConfigPath(), buildCliChatConfig(reasoning));
    const engineService = new CapturingEngineService();
    await new StatusPresetRunner(engineService).run(
      { presetId: 'cli-chat', prompt: 'hello', repoRoot: process.cwd() },
      { statusBackendUrl: 'http://127.0.0.1:1/status' },
    );
    const request = engineService.repoSearchRequests[0];
    assert.ok(request, 'expected the chat preset to reach executeRepoSearch');
    return request;
  });
}

test('selectPresetRunKind maps summary presets to the summary runner', () => {
  assert.equal(selectPresetRunKind('summary'), 'summary');
});

test('selectPresetRunKind maps chat presets to the chat runner', () => {
  assert.equal(selectPresetRunKind('chat'), 'chat');
});

test('selectPresetRunKind routes plan and repo-search presets to the repo-search runner', () => {
  assert.equal(selectPresetRunKind('plan'), 'repo-search');
  assert.equal(selectPresetRunKind('repo-search'), 'repo-search');
});

test('cli chat disables thinking when the active preset reasoning is off', async () => {
  const request = await runCliChatPreset('off');

  assert.equal(request.thinkingEnabled, false);
});

test('cli chat enables thinking when the active preset reasoning is on', async () => {
  const request = await runCliChatPreset('on');

  assert.equal(request.thinkingEnabled, true);
});
