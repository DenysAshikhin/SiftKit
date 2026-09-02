import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ModelRuntimePresetSchema, SiftPresetSchema } from '@siftkit/contracts';
import { awaitRepoSearchRunPersistence, executeRepoSearchRequest } from '../src/repo-search/execute.js';
import { getActiveModelPreset } from '../src/config/getters.js';
import { parseJsonValueText } from '../src/lib/json.js';
import { PresetCatalog } from '../src/preset-catalog.js';
import type { RepoSearchTaskKind } from '../src/repo-search/task-kind.js';
import { loadDashboardRuns } from '../src/status-server/dashboard-runs/queries.js';
import { INTERACTIVE_REPO_TOOL_NAMES } from '../src/planner-protocol/repo-search.js';
import type { RepoSearchProgressEvent } from '../src/repo-search/types.js';
import { CollectingProgressWriter } from './helpers/collecting-progress-writer.js';
import { mockModelPreset, mockSiftConfig } from './helpers/mock-config.js';
import { DEAD_BASE_URL, DeadEndpointEnv } from './helpers/dead-endpoints.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';
import { repoAgentFinishResponses } from './helpers/repo-agent-mock-responses.js';

// Execution posts run status; these tests assert on progress events only.
const deadEndpoints = new DeadEndpointEnv();
before(() => { deadEndpoints.apply(); });
after(() => { deadEndpoints.restore(); });

const MOCK_CONFIG = mockSiftConfig({
  Runtime: { LlamaCpp: { BaseUrl: DEAD_BASE_URL, NumCtx: 32000 } },
});

async function readRepoAgentMaxTurns(requestedMaxTurns?: number): Promise<number | undefined> {
  const dir = createManagedTempDir('siftkit-agent-turns-');
  const events: RepoSearchProgressEvent[] = [];
  try {
    await executeRepoSearchRequest({
      presetId: 'repo-search',
      taskKind: 'repo-agent',
      prompt: 'finish immediately',
      repoRoot: dir,
      config: MOCK_CONFIG,
      model: 'mock',
      ...(requestedMaxTurns === undefined ? {} : { maxTurns: requestedMaxTurns }),
      allowedTools: [...INTERACTIVE_REPO_TOOL_NAMES],
      availableModels: ['mock'],
      mockResponses: repoAgentFinishResponses('done'),
      mockCommandResults: {},
      progressWriter: new CollectingProgressWriter(events),
    });
    return events.find((event) => event.kind === 'llm_start')?.maxTurns;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('repo-agent defaults to 100 turns and preserves an explicit higher override', async () => {
  assert.equal(await readRepoAgentMaxTurns(), 100);
  assert.equal(await readRepoAgentMaxTurns(125), 125);
});

test('repo-agent resumes after compacting recoverable reasoning history', async () => {
  const dir = createManagedTempDir('siftkit-agent-compaction-');
  try {
    const result = await executeRepoSearchRequest({
      presetId: 'repo-search',
      taskKind: 'repo-agent',
      prompt: 'inspect the helper directory',
      repoRoot: dir,
      config: mockSiftConfig({
        Runtime: { LlamaCpp: { NumCtx: 9_000 } },
        Server: {
          ModelPresets: {
            ActivePresetId: 'default',
            Presets: [{
              id: 'default',
              Reasoning: 'on',
              ReasoningContent: true,
              PreserveThinking: true,
              MaintainPerStepThinking: true,
              IdleAction: 'unload',
            }],
          },
        },
      }),
      model: 'mock',
      allowedTools: [...INTERACTIVE_REPO_TOOL_NAMES],
      availableModels: ['mock'],
      mockResponses: [
        {
          thinking: 'H'.repeat(18_000),
          toolCalls: [{ name: 'ls', arguments: { path: '.', limit: 1 } }],
        },
        { content: 'SUMMARY BODY' },
        ...repoAgentFinishResponses('completed after compaction'),
      ],
      mockCommandResults: {},
    });

    assert.equal(result.scorecard.verdict, 'pass');
    assert.equal(result.scorecard.tasks[0]?.finalOutput, 'completed after compaction');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('repo-agent attempts compaction and fails when its summarization prompt is oversized', async () => {
  const dir = createManagedTempDir('siftkit-agent-overflow-');
  try {
    await assert.rejects(
      executeRepoSearchRequest({
      presetId: 'repo-search',
        taskKind: 'repo-agent',
        prompt: 'Q'.repeat(60_000),
        repoRoot: dir,
        config: mockSiftConfig({ Runtime: { LlamaCpp: { NumCtx: 9_000 } } }),
        model: 'mock',
        allowedTools: [...INTERACTIVE_REPO_TOOL_NAMES],
        availableModels: ['mock'],
        mockResponses: [{ content: 'SUMMARY BODY' }],
        mockCommandResults: {},
      }),
      /planner_compaction_prompt_overflow.*total_context_tokens=9000/u,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('repo-agent automatically trims noisy validation run output', async () => {
  const dir = createManagedTempDir('siftkit-agent-validation-');
  fs.writeFileSync(
    path.join(dir, 'validation.cjs'),
    'for (let index = 1; index <= 60; index += 1) console.log(`validation-line-${index}`);\n',
    'utf8',
  );
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ scripts: { test: 'node validation.cjs' } }),
    'utf8',
  );
  try {
    const result = await executeRepoSearchRequest({
      presetId: 'repo-search',
      taskKind: 'repo-agent',
      prompt: 'run the validation test',
      repoRoot: dir,
      config: MOCK_CONFIG,
      model: 'mock',
      maxTurns: 4,
      allowedTools: [...INTERACTIVE_REPO_TOOL_NAMES],
      availableModels: ['mock'],
      mockResponses: [
        { toolCalls: [{ name: "run", arguments: {"command":"npm test"} }] },
        ...repoAgentFinishResponses('validation passed'),
      ],
      mockCommandResults: {},
    });
    const command = result.scorecard.tasks[0]?.commands[0];
    if (!command) {
      throw new Error('Expected repo-agent to record the validation command.');
    }
    assert.equal(command.exitCode, 0);
    assert.match(command.output, /lines omitted from validation command output\./u);
    assert.doesNotMatch(command.output, /validation-line-1\b/u);
    assert.match(command.output, /validation-line-60\b/u);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Run-log persistence is deferred off the request path, so the write lands after the request
// promise resolves. Callers that tear the runtime down — every test harness — need a handle on
// it; without one the late write reopens runtime.sqlite behind whoever just closed it.
test('awaitRepoSearchRunPersistence resolves only once the deferred run log has landed', async () => {
  const dir = createManagedTempDir('siftkit-agent-persist-');
  const previousCwd = process.cwd();
  process.chdir(dir);
  try {
    await executeRepoSearchRequest({
      presetId: 'repo-search',
      taskKind: 'repo-agent',
      prompt: 'finish immediately',
      repoRoot: dir,
      config: MOCK_CONFIG,
      model: 'mock',
      allowedTools: [...INTERACTIVE_REPO_TOOL_NAMES],
      availableModels: ['mock'],
      mockResponses: repoAgentFinishResponses('done'),
      mockCommandResults: {},
      progressWriter: new CollectingProgressWriter([]),
    });
    assert.equal(loadDashboardRuns(path.join(dir, '.siftkit')).length, 0);

    await awaitRepoSearchRunPersistence();

    assert.equal(loadDashboardRuns(path.join(dir, '.siftkit')).length, 1);
  } finally {
    process.chdir(previousCwd);
  }
});

test('repo-agent applies write content verbatim without an approval gate', async () => {
  const dir = createManagedTempDir('siftkit-agent-exec-');
  const content = '\n  agent wrote this\n';
  try {
    const result = await executeRepoSearchRequest({
      presetId: 'repo-search',
      taskKind: 'repo-agent',
      prompt: 'create out.txt',
      repoRoot: dir,
      config: MOCK_CONFIG,
      model: 'mock',
      maxTurns: 4,
      allowedTools: [...INTERACTIVE_REPO_TOOL_NAMES],
      availableModels: ['mock'],
      mockResponses: [
        { toolCalls: [{ name: 'write', arguments: { path: 'out.txt', content } }] },
        ...repoAgentFinishResponses('created out.txt'),
      ],
      mockCommandResults: {},
    });
    assert.equal(result.scorecard.verdict === 'fail', false);
    assert.equal(fs.readFileSync(path.join(dir, 'out.txt'), 'utf8'), content);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('repo-agent uses ExpandReads=false and still skips already-returned lines', async () => {
  const dir = createManagedTempDir('siftkit-agent-exec-');
  fs.writeFileSync(
    path.join(dir, 'a.ts'),
    Array.from({ length: 200 }, (_, index) => `a.ts-line-${index + 1}`).join('\n'),
    'utf8',
  );
  try {
    const result = await executeRepoSearchRequest({
      presetId: 'repo-search',
      taskKind: 'repo-agent',
      prompt: 'Read a file twice.',
      repoRoot: dir,
      config: mockSiftConfig({ ExpandReads: false }),
      model: 'mock',
      maxTurns: 6,
      allowedTools: [...INTERACTIVE_REPO_TOOL_NAMES],
      availableModels: ['mock'],
      mockResponses: [
        { toolCalls: [{ name: "read", arguments: {"path":"a.ts","offset":100,"limit":20} }] },
        { toolCalls: [{ name: "read", arguments: {"path":"a.ts","offset":110,"limit":20} }] },
        ...repoAgentFinishResponses('done'),
        { content: '{"verdict":"pass","reason":"supported"}' },
      ],
      mockCommandResults: {},
    });
    assert.notEqual(result.scorecard.verdict, 'fail');
    // 100-119 then 120-129: the second read skips the returned span and stops at its requested end.
    assert.equal(result.scorecard.readOverlapSummary.totalOverlapLines, 0);
    assert.equal(result.scorecard.readOverlapSummary.totalUniqueLinesRead, 30);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function findPersistedRun(runtimeRoot: string, requestId: string) {
  const run = loadDashboardRuns(runtimeRoot).find((candidate) => candidate.id === requestId);
  if (!run) {
    throw new Error(`Expected run ${requestId} to be persisted.`);
  }
  return run;
}

// The engine collapses repo-agent into the legacy repo_search grouping; the canonical identity
// must survive beside it, and the preset snapshots must describe the configuration the run used
// even when the live configuration changes before the deferred write lands.
test('completed runs persist canonical operation identity beside the legacy grouping', async () => {
  const dir = createManagedTempDir('siftkit-agent-identity-');
  const previousCwd = process.cwd();
  process.chdir(dir);
  try {
    const config = mockSiftConfig({ Runtime: { LlamaCpp: { BaseUrl: DEAD_BASE_URL, NumCtx: 32000 } } });
    const activeModelPreset = getActiveModelPreset(config);
    const originalModel = activeModelPreset.Model;
    const operationPreset = PresetCatalog.fromPresets(config.Presets).requireById('repo-search');
    await executeRepoSearchRequest({
      presetId: 'repo-search',
      taskKind: 'repo-agent',
      requestId: 'identity-agent',
      prompt: 'finish immediately',
      repoRoot: dir,
      config,
      model: 'mock',
      allowedTools: [...INTERACTIVE_REPO_TOOL_NAMES],
      availableModels: ['mock'],
      mockResponses: repoAgentFinishResponses('done'),
      mockCommandResults: {},
      progressWriter: new CollectingProgressWriter([]),
    });
    for (const preset of config.Presets) {
      preset.promptPrefix = 'MUTATED AFTER THE RUN';
    }
    activeModelPreset.Model = 'mutated-after-the-run';
    await awaitRepoSearchRunPersistence();

    const run = findPersistedRun(path.join(dir, '.siftkit'), 'identity-agent');
    assert.equal(run.kind, 'repo_search');
    assert.equal(run.status, 'completed');
    assert.equal(run.operationType, 'repo-agent');
    assert.equal(run.operationPresetId, 'repo-search');
    assert.equal(run.modelPresetId, activeModelPreset.id);
    assert.deepEqual(SiftPresetSchema.parse(parseJsonValueText(run.operationPresetJson ?? '')), operationPreset);
    assert.equal(ModelRuntimePresetSchema.parse(parseJsonValueText(run.modelPresetJson ?? '')).Model, originalModel);
  } finally {
    process.chdir(previousCwd);
  }
});

test('failed runs persist canonical operation identity', async () => {
  const dir = createManagedTempDir('siftkit-agent-identity-failed-');
  const previousCwd = process.cwd();
  process.chdir(dir);
  try {
    const config = mockSiftConfig({ Runtime: { LlamaCpp: { BaseUrl: DEAD_BASE_URL, NumCtx: 9_000 } } });
    await assert.rejects(executeRepoSearchRequest({
      presetId: 'repo-search',
      taskKind: 'repo-agent',
      requestId: 'identity-agent-failed',
      prompt: 'Q'.repeat(60_000),
      repoRoot: dir,
      config,
      model: 'mock',
      allowedTools: [...INTERACTIVE_REPO_TOOL_NAMES],
      availableModels: ['mock'],
      mockResponses: [{ content: 'SUMMARY BODY' }],
      mockCommandResults: {},
    }));
    await awaitRepoSearchRunPersistence();

    const run = findPersistedRun(path.join(dir, '.siftkit'), 'identity-agent-failed');
    assert.equal(run.kind, 'repo_search');
    assert.equal(run.status, 'failed');
    assert.equal(run.operationType, 'repo-agent');
    assert.equal(run.operationPresetId, 'repo-search');
    assert.equal(run.modelPresetId, getActiveModelPreset(config).id);
    assert.equal(typeof run.operationPresetJson, 'string');
    assert.equal(typeof run.modelPresetJson, 'string');
  } finally {
    process.chdir(previousCwd);
  }
});

test('every engine operation type persists its own canonical identity', async () => {
  const dir = createManagedTempDir('siftkit-identity-kinds-');
  const previousCwd = process.cwd();
  process.chdir(dir);
  try {
    const cases: { taskKind: RepoSearchTaskKind; presetId: string; kind: string }[] = [
      { taskKind: 'repo-search', presetId: 'repo-search', kind: 'repo_search' },
      { taskKind: 'plan', presetId: 'plan', kind: 'plan' },
      { taskKind: 'chat', presetId: 'chat', kind: 'repo_search' },
    ];
    for (const entry of cases) {
      await executeRepoSearchRequest({
        presetId: entry.presetId,
        taskKind: entry.taskKind,
        requestId: `identity-${entry.taskKind}`,
        prompt: 'finish immediately',
        repoRoot: dir,
        config: MOCK_CONFIG,
        model: 'mock',
        ...(entry.taskKind === 'chat' ? { systemPrompt: 'assistant', allowedTools: [] } : {}),
        availableModels: ['mock'],
        mockResponses: [{ content: 'done' }],
        mockCommandResults: {},
      });
    }
    await awaitRepoSearchRunPersistence();

    for (const entry of cases) {
      const run = findPersistedRun(path.join(dir, '.siftkit'), `identity-${entry.taskKind}`);
      assert.equal(run.kind, entry.kind, entry.taskKind);
      assert.equal(run.operationType, entry.taskKind);
      assert.equal(run.operationPresetId, entry.presetId);
      assert.equal(run.modelPresetId, getActiveModelPreset(MOCK_CONFIG).id);
    }
  } finally {
    process.chdir(previousCwd);
  }
});

test('chat runs persist the session model-preset snapshot rather than the active global preset', async () => {
  const dir = createManagedTempDir('siftkit-identity-session-');
  const previousCwd = process.cwd();
  process.chdir(dir);
  try {
    const sessionPreset = mockModelPreset({ id: 'session-snapshot', Model: 'session-model' });
    assert.notEqual(sessionPreset.id, getActiveModelPreset(MOCK_CONFIG).id);
    await executeRepoSearchRequest({
      presetId: 'chat',
      taskKind: 'chat',
      requestId: 'identity-session-chat',
      prompt: 'hello',
      repoRoot: dir,
      config: MOCK_CONFIG,
      modelPresetId: sessionPreset.id,
      modelPreset: sessionPreset,
      model: 'mock',
      systemPrompt: 'assistant',
      allowedTools: [],
      availableModels: ['mock'],
      mockResponses: [{ content: 'hi' }],
      mockCommandResults: {},
    });
    await awaitRepoSearchRunPersistence();

    const run = findPersistedRun(path.join(dir, '.siftkit'), 'identity-session-chat');
    assert.equal(run.operationType, 'chat');
    assert.equal(run.modelPresetId, 'session-snapshot');
    assert.deepEqual(ModelRuntimePresetSchema.parse(parseJsonValueText(run.modelPresetJson ?? '')), sessionPreset);
  } finally {
    process.chdir(previousCwd);
  }
});
