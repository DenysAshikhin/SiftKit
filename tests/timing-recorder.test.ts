import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { executeRepoSearchRequest } from '../dist/repo-search/index.js';
import { summarizeRequest } from '../dist/summary.js';
import { createTemporaryTimingRecorderFromEnv } from '../src/lib/temporary-timing-recorder.js';
import { withTestEnvAndServer } from './_test-helpers.js';
import {
  buildOversizedTransitionsInput,
  getChunkThresholdCharacters,
  loadConfig,
  withStubServer,
  withTempEnv,
} from './_runtime-helpers.js';

function withTemporaryEnv(values: Record<string, string | undefined>, run: () => Promise<void> | void): Promise<void> | void {
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(values)) {
    previous[key] = process.env[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  const restore = (): void => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
  try {
    const result = run();
    if (result && typeof result.then === 'function') {
      return result.finally(restore);
    }
    restore();
    return undefined;
  } catch (error) {
    restore();
    throw error;
  }
}

test('createTemporaryTimingRecorderFromEnv returns null when temp timing trace is disabled', () => {
  withTemporaryEnv({
    SIFTKIT_TEMP_TIMING_TRACE: undefined,
    SIFTKIT_TEMP_TIMING_TRACE_FILE: undefined,
    SIFTKIT_TEMP_TIMING_TRACE_DIR: undefined,
  }, () => {
    const recorder = createTemporaryTimingRecorderFromEnv({
      kind: 'repo-search',
      requestId: 'req-disabled',
      metadata: { promptChars: 12 },
    });
    assert.equal(recorder, null);
  });
});

test('temporary timing recorder writes event details and label summaries to a temp json file', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-timing-test-'));
  const tracePath = path.join(tempRoot, 'trace.json');

  await withTemporaryEnv({
    SIFTKIT_TEMP_TIMING_TRACE: '1',
    SIFTKIT_TEMP_TIMING_TRACE_FILE: tracePath,
    SIFTKIT_TEMP_TIMING_TRACE_DIR: undefined,
  }, async () => {
    const recorder = createTemporaryTimingRecorderFromEnv({
      kind: 'repo-search',
      requestId: 'req-enabled',
      metadata: { promptChars: 12 },
    });
    assert.notEqual(recorder, null);

    const firstSpan = recorder.start('repo.prompt.render', { turn: 1 });
    firstSpan.end({ promptChars: 99 });
    const secondSpan = recorder.start('repo.prompt.render', { turn: 2 });
    secondSpan.end();
    await recorder.flush({ status: 'completed' });

    const trace = JSON.parse(fs.readFileSync(tracePath, 'utf8')) as {
      kind: string;
      requestId: string;
      status: string;
      metadata: { promptChars: number };
      events: Array<{ label: string; durationMs: number; metadata: Record<string, number> }>;
      summary: Array<{ label: string; calls: number; totalMs: number; maxMs: number }>;
    };

    assert.equal(trace.kind, 'repo-search');
    assert.equal(trace.requestId, 'req-enabled');
    assert.equal(trace.status, 'completed');
    assert.equal(trace.metadata.promptChars, 12);
    assert.equal(trace.events.length, 2);
    assert.equal(trace.events[0].label, 'repo.prompt.render');
    assert.equal(trace.events[0].metadata.turn, 1);
    assert.equal(trace.events[0].metadata.promptChars, 99);
    assert.ok(trace.events[0].durationMs >= 0);
    assert.deepEqual(trace.summary.map((entry) => ({
      label: entry.label,
      calls: entry.calls,
    })), [
      { label: 'repo.prompt.render', calls: 2 },
    ]);
    assert.ok(trace.summary[0].totalMs >= 0);
    assert.ok(trace.summary[0].maxMs >= 0);
  });
});

test('repo-search execution dumps temp timing json with llama and tool phases', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-repo-timing-test-'));
  const tracePath = path.join(tempRoot, 'repo-trace.json');

  await withTemporaryEnv({
    SIFTKIT_TEMP_TIMING_TRACE: '1',
    SIFTKIT_TEMP_TIMING_TRACE_FILE: tracePath,
    SIFTKIT_TEMP_TIMING_TRACE_DIR: undefined,
  }, async () => {
    await withTestEnvAndServer(async ({ tempRoot: repoRoot }) => {
      const result = await executeRepoSearchRequest({
        prompt: 'find build scripts',
        repoRoot,
        maxTurns: 2,
        mockResponses: [
          '{"action":"tool","tool_name":"repo_git","args":{"command":"git status --short"}}',
          '{"action":"finish","output":"Found scripts","confidence":0.8}',
        ],
        mockCommandResults: {
          'git status --short': { exitCode: 0, stdout: '', stderr: '' },
        },
      });
      assert.equal(result.scorecard.verdict, 'pass');
    });

    const trace = JSON.parse(fs.readFileSync(tracePath, 'utf8')) as {
      kind: string;
      status: string;
      summary: Array<{ label: string; calls: number }>;
    };
    const labels = new Set(trace.summary.map((entry) => entry.label));
    assert.equal(trace.kind, 'repo-search');
    assert.equal(trace.status, 'completed');
    assert.equal(labels.has('repo.llama.request'), true);
    assert.equal(labels.has('repo.tool.execute'), true);
    assert.equal(labels.has('repo.tool.append'), true);
    assert.equal(labels.has('repo.tool.prompt_tokens'), false);
    assert.equal(labels.has('repo.run_log.persist'), false);
    assert.equal(labels.has('repo.run_log.schedule'), true);
  });
});

test('summary planner dumps temp timing json with planner llama and tool phases', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-summary-timing-test-'));
  const tracePath = path.join(tempRoot, 'summary-trace.json');

  await withTemporaryEnv({
    SIFTKIT_TEMP_TIMING_TRACE: '1',
    SIFTKIT_TEMP_TIMING_TRACE_FILE: tracePath,
    SIFTKIT_TEMP_TIMING_TRACE_DIR: undefined,
  }, async () => {
    await withTempEnv(async () => {
      await withStubServer(async () => {
        const config = await loadConfig({ ensure: true });
        const threshold = getChunkThresholdCharacters(config);
        const inputText = buildOversizedTransitionsInput(threshold + 1000);
        const result = await summarizeRequest({
          question: 'Find all transitions in the Lumbridge Castle area.',
          inputText,
          format: 'text',
          policyProfile: 'general',
          backend: 'llama.cpp',
          model: 'mock-model',
          skipExecutionLock: true,
        });
        assert.equal(result.Classification, 'summary');
        assert.equal(result.Summary, 'timing trace completed');
      }, {
        assistantContent(promptText: string, parsed: Record<string, unknown>, requestIndex: number) {
          if (requestIndex === 1) {
            return JSON.stringify({
              action: 'tool',
              tool_name: 'json_filter',
              args: {
                filters: [{ path: 'from.worldX', op: 'gte', value: 3200 }],
                limit: 1,
              },
            });
          }
          return JSON.stringify({
            action: 'finish',
            classification: 'summary',
            raw_review_required: false,
            output: 'timing trace completed',
          });
        },
      });
    });

    const trace = JSON.parse(fs.readFileSync(tracePath, 'utf8')) as {
      kind: string;
      status: string;
      summary: Array<{ label: string; calls: number }>;
    };
    const labels = new Set(trace.summary.map((entry) => entry.label));
    assert.equal(trace.kind, 'summary');
    assert.equal(trace.status, 'completed');
    assert.equal(labels.has('summary.planner.llama.request'), true);
    assert.equal(labels.has('summary.planner.tool.execute'), true);
    assert.equal(labels.has('summary.planner.tool.append'), true);
  });
});
