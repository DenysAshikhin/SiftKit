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

test('repo-agent uses ExpandReads=false and records overlapping reads', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-agent-exec-'));
  fs.writeFileSync(
    path.join(dir, 'a.ts'),
    Array.from({ length: 200 }, (_, index) => `a.ts-line-${index + 1}`).join('\n'),
    'utf8',
  );
  try {
    const result = await executeRepoSearchRequest({
      taskKind: 'repo-agent',
      prompt: 'Read a file twice.',
      repoRoot: dir,
      config: mockSiftConfig({ ExpandReads: false }),
      model: 'mock',
      maxTurns: 6,
      includeAgentsMd: false,
      includeRepoFileListing: true,
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
    assert.equal(result.scorecard.readOverlapSummary.totalOverlapLines, 10);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
