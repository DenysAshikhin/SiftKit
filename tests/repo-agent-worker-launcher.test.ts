import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test, { after, before } from 'node:test';

import { z } from '../src/lib/zod.js';
import {
  RepoAgentRunRequestSchema,
  type RepoAgentRunRequest,
} from '../src/repo-agent/run-schemas.js';
import { RepoAgentRunStore } from '../src/repo-agent/run-store.js';
import {
  getRepoAgentWorkerEntrypoint,
  RepoAgentWorkerLauncher,
} from '../src/repo-agent/worker-launcher.js';

const TEMP_ROOT = join(
  process.cwd(),
  '.tmp',
  `repo-agent-worker-launcher-tests-${process.pid}`,
);

const FixtureResultSchema = z.strictObject({
  pid: z.number().int().positive(),
  args: z.tuple([z.string().uuid(), z.string().min(1)]),
});

before(() => {
  rmSync(TEMP_ROOT, { recursive: true, force: true });
  mkdirSync(TEMP_ROOT, { recursive: true });
});

after(() => {
  rmSync(TEMP_ROOT, { recursive: true, force: true });
});

function makeRequest(runId = randomUUID()): RepoAgentRunRequest {
  return RepoAgentRunRequestSchema.parse({
    runId,
    task: 'sensitive task text that must not enter argv',
    repoRoot: process.cwd(),
    approval: 'auto',
  });
}

async function waitForFile(filePath: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (existsSync(filePath)) {
      return;
    }
    await delay(10);
  }
  throw new Error(`Timed out waiting for ${filePath}.`);
}

test('launch passes only entrypoint, run ID, and runs root to a detached worker', async () => {
  const runsRoot = join(TEMP_ROOT, randomUUID());
  mkdirSync(runsRoot);
  const store = new RepoAgentRunStore(runsRoot);
  const request = makeRequest();
  store.create(request);
  const fixturePath = join(TEMP_ROOT, 'fixture-worker.cjs');
  writeFileSync(
    fixturePath,
    [
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      'const runId = process.argv[2];',
      'const runsRoot = process.argv[3];',
      "fs.writeFileSync(path.join(runsRoot, runId, 'fixture-result.json'),",
      "  JSON.stringify({ pid: process.pid, args: [runId, runsRoot] }), 'utf8');",
    ].join('\n'),
    'utf8',
  );

  const launcher = new RepoAgentWorkerLauncher({
    nodeExecutable: process.execPath,
    workerEntrypoint: fixturePath,
    store,
  });
  const pid = launcher.launch(request.runId);
  const resultPath = join(runsRoot, request.runId, 'fixture-result.json');
  await waitForFile(resultPath);
  const result = FixtureResultSchema.parse(
    JSON.parse(readFileSync(resultPath, 'utf8')),
  );
  assert.equal(result.pid, pid);
  assert.deepEqual(result.args, [request.runId, runsRoot]);
  assert.equal(JSON.stringify(result).includes(request.task), false);
});

test('missing worker entrypoint fails before launch and records failed state', () => {
  const runsRoot = join(TEMP_ROOT, randomUUID());
  mkdirSync(runsRoot);
  const store = new RepoAgentRunStore(runsRoot);
  const request = makeRequest();
  store.create(request);
  const launcher = new RepoAgentWorkerLauncher({
    nodeExecutable: process.execPath,
    workerEntrypoint: join(TEMP_ROOT, 'missing-worker.js'),
    store,
  });
  assert.throws(() => launcher.launch(request.runId), /entrypoint|not found/iu);
  const state = store.readState(request.runId);
  assert.equal(state.status, 'failed');
});

test('missing node executable fails before launch and records failed state', () => {
  const runsRoot = join(TEMP_ROOT, randomUUID());
  mkdirSync(runsRoot);
  const store = new RepoAgentRunStore(runsRoot);
  const request = makeRequest();
  store.create(request);
  const fixturePath = join(TEMP_ROOT, 'existing-worker.js');
  writeFileSync(fixturePath, '', 'utf8');
  const launcher = new RepoAgentWorkerLauncher({
    nodeExecutable: join(TEMP_ROOT, 'missing-node.exe'),
    workerEntrypoint: fixturePath,
    store,
  });
  assert.throws(() => launcher.launch(request.runId), /node executable|not found/iu);
  const state = store.readState(request.runId);
  assert.equal(state.status, 'failed');
});

test('launch failure does not overwrite an already-aborted state', () => {
  const runsRoot = join(TEMP_ROOT, randomUUID());
  mkdirSync(runsRoot);
  const store = new RepoAgentRunStore(runsRoot);
  const request = makeRequest();
  store.create(request);
  store.transition(request.runId, 0, {
    runId: request.runId,
    revision: 1,
    updatedAtUtc: new Date().toISOString(),
    status: 'aborted',
    pid: process.pid,
  });
  const launcher = new RepoAgentWorkerLauncher({
    nodeExecutable: process.execPath,
    workerEntrypoint: join(TEMP_ROOT, 'still-missing.js'),
    store,
  });
  assert.throws(() => launcher.launch(request.runId));
  assert.equal(store.readState(request.runId).status, 'aborted');
});

test('production worker entrypoint resolves beside the launcher', () => {
  assert.match(
    getRepoAgentWorkerEntrypoint(),
    /[\\/]repo-agent[\\/]worker-main\.js$/u,
  );
});
