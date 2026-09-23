import { IsolatedRuntime } from '../helpers/isolated-runtime.js';
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { executeRepoSearchRequest } from '../../src/repo-search/execute.js';
import { INTERACTIVE_REPO_TOOL_NAMES } from '../../src/planner-protocol/repo-search.js';
import { mockSiftConfig } from '../helpers/mock-config.js';
import { DEAD_BASE_URL, DeadEndpointEnv } from '../helpers/dead-endpoints.js';
import { createManagedTempDir } from '../helpers/temp-dirs.js';
import { repoAgentFinishResponses } from '../helpers/repo-agent-mock-responses.js';

// Execution posts run status; these tests assert on progress events only.
const isolatedRuntime = new IsolatedRuntime();
const deadEndpoints = new DeadEndpointEnv();
before(() => { isolatedRuntime.start(); deadEndpoints.apply(); });
after(async () => { await isolatedRuntime.close(); deadEndpoints.restore(); });

const MOCK_CONFIG = mockSiftConfig({
  Server: { ModelPresets: { Presets: [{ BaseUrl: DEAD_BASE_URL, NumCtx: 32000 }] } },
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
