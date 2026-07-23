import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { executeRepoSearchRequest } from '../src/repo-search/execute.js';
import { INTERACTIVE_REPO_TOOL_NAMES } from '../src/repo-search/planner-protocol.js';
import { mockSiftConfig } from './helpers/mock-config.js';

const MOCK_CONFIG = mockSiftConfig({
  Runtime: { LlamaCpp: { BaseUrl: 'http://127.0.0.1:1', NumCtx: 32000 } },
});

test('repo-agent taskKind runs the agent prompt and applies a write without approval gate', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-agent-exec-'));
  try {
    const result = await executeRepoSearchRequest({
      taskKind: 'repo-agent',
      prompt: 'create out.txt',
      repoRoot: dir,
      config: MOCK_CONFIG,
      model: 'mock',
      maxTurns: 4,
      includeAgentsMd: false,
      includeRepoFileListing: true,
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
