import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { awaitRepoSearchRunPersistence, executeRepoSearchRequest } from '../src/repo-search/execute.js';
import { loadDashboardRuns } from '../src/status-server/dashboard-runs/queries.js';
import { INTERACTIVE_REPO_TOOL_NAMES } from '../src/repo-search/planner-protocol.js';
import type { RepoSearchProgressEvent } from '../src/repo-search/types.js';
import { CollectingProgressWriter } from './helpers/collecting-progress-writer.js';
import { mockSiftConfig } from './helpers/mock-config.js';
import { DeadEndpointEnv } from './helpers/dead-endpoints.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';

// Execution posts run status; these tests assert on progress events only.
const deadEndpoints = new DeadEndpointEnv();
before(() => { deadEndpoints.apply(); });
after(() => { deadEndpoints.restore(); });

const MOCK_CONFIG = mockSiftConfig({
  Runtime: { LlamaCpp: { BaseUrl: 'http://127.0.0.1:1', NumCtx: 32000 } },
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
      mockResponses: ['{"action":"finish","output":"done"}'],
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

test('repo-agent selects fail context policy and surfaces overflow without a model call', async () => {
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
        mockResponses: ['{"action":"finish","output":"must not run"}'],
        mockCommandResults: {},
      }),
      /planner_preflight_overflow.*context_overflow_policy=fail/u,
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
        '{"action":"run","command":"npm test"}',
        '{"action":"finish","output":"validation passed"}',
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
      mockResponses: ['{"action":"finish","output":"done"}'],
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

test('repo-agent taskKind runs the agent prompt and applies a write without approval gate', async () => {
  const dir = createManagedTempDir('siftkit-agent-exec-');
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
        '{"action":"write","path":"out.txt","content":"agent wrote this"}',
        '{"action":"finish","output":"created out.txt"}',
      ],
      mockCommandResults: {},
    });
    assert.equal(result.scorecard.verdict === 'fail', false);
    assert.equal(fs.readFileSync(path.join(dir, 'out.txt'), 'utf8'), 'agent wrote this');
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
        '{"action":"read","path":"a.ts","offset":100,"limit":20}',
        '{"action":"read","path":"a.ts","offset":110,"limit":20}',
        '{"action":"finish","output":"done"}',
        '{"verdict":"pass","reason":"supported"}',
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
