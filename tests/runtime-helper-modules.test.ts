import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

import {
  getDefaultConfig,
  mergeConfig,
  getRuntimeRootFromStatusPath,
  getPlannerLogsPath,
} from './helpers/runtime-config.js';
import {
  resolveArtifactLogPathFromStatusPost,
} from './helpers/runtime-http.js';
import { JsonObjectSchema } from '../src/lib/json-types.js';
import { writeManagedEngineLauncher } from './helpers/managed-engine-fixtures.js';
import { createManagedTempDir, removeDirectoryWithRetries } from './helpers/temp-dirs.js';
import { OutputCapture } from './helpers/stdout-capture.js';

test('OutputCapture collects complete and partial lines and restores idempotently', () => {
  const stdout = OutputCapture.start(process.stdout);
  process.stdout.write('stdout-complete\nstdout-partial');
  stdout.restore();
  stdout.restore();
  process.stdout.write('-after-restore\n');
  assert.deepEqual(stdout.lines, ['stdout-complete', 'stdout-partial']);

  const stderr = OutputCapture.start(process.stderr);
  process.stderr.write('stderr-complete\nstderr-partial');
  stderr.restore();
  stderr.restore();
  process.stderr.write('-after-restore\n');
  assert.deepEqual(stderr.lines, ['stderr-complete', 'stderr-partial']);
});

test('output capture has no callback helpers or local duplicate declarations', () => {
  const testRoot = path.resolve('tests');
  const sourcePaths = fs.readdirSync(testRoot, { recursive: true })
    .filter((entry): entry is string => typeof entry === 'string' && entry.endsWith('.ts'))
    .map((entry) => path.join(testRoot, entry));
  for (const sourcePath of sourcePaths) {
    const source = fs.readFileSync(sourcePath, 'utf8');
    assert.doesNotMatch(
      source,
      /(?:async\s+)?function\s+capture(?:Stdout|Stderr)(?:Lines)?\s*\(/u,
      sourcePath,
    );
  }
});

// mergeConfig is a heterogeneous deep-merge that returns JsonValue; for the config-merge
// case the test exercises, the result carries the merged Runtime plus a Thresholds bag
// (with derived keys stripped). Validate that shape at the boundary so reads stay typed.
const MergedRuntimeConfigSchema = z
  .object({
    Runtime: z.object({ Engine: z.object({ BaseUrl: z.string() }).passthrough() }).passthrough(),
    Thresholds: JsonObjectSchema,
  })
  .passthrough();

test('runtime config helpers merge nested overrides and strip derived fields', () => {
  const config = getDefaultConfig();
  const merged = MergedRuntimeConfigSchema.parse(mergeConfig(config, {
    Runtime: {
      Engine: {
        BaseUrl: 'http://127.0.0.1:9999',
      },
    },
    Paths: {
      Ignored: true,
    },
    Effective: {
      Ignored: true,
    },
    Thresholds: {
      MaxInputCharacters: 123,
    },
  }));

  assert.equal(merged.Runtime.Engine.BaseUrl, 'http://127.0.0.1:9999');
  assert.equal('Paths' in merged, false);
  assert.equal('Effective' in merged, false);
  assert.equal('MaxInputCharacters' in merged.Thresholds, false);
});

test('runtime path helpers resolve planner request artifact paths from the status root', () => {
  const statusPath = path.join(path.parse(process.cwd()).root, 'tmp', 'runtime-root', 'status', 'inference.txt');

  assert.equal(
    getRuntimeRootFromStatusPath(statusPath),
    path.join(path.parse(process.cwd()).root, 'tmp', 'runtime-root'),
  );

  const priorLegacyStatusPath = process.env.sift_kit_status;
  const priorStatusPath = process.env.SIFTKIT_STATUS_PATH;
  process.env.sift_kit_status = statusPath;
  process.env.SIFTKIT_STATUS_PATH = statusPath;
  try {
    assert.equal(
      getPlannerLogsPath(),
      path.join(path.parse(process.cwd()).root, 'tmp', 'runtime-root', 'logs'),
    );
  } finally {
    if (priorLegacyStatusPath === undefined) {
      delete process.env.sift_kit_status;
    } else {
      process.env.sift_kit_status = priorLegacyStatusPath;
    }
    if (priorStatusPath === undefined) {
      delete process.env.SIFTKIT_STATUS_PATH;
    } else {
      process.env.SIFTKIT_STATUS_PATH = priorStatusPath;
    }
  }

  assert.equal(
    resolveArtifactLogPathFromStatusPost({
      artifactType: 'summary_request',
      artifactRequestId: 'abc123',
      statusPath,
    }),
    path.join(path.parse(process.cwd()).root, 'tmp', 'runtime-root', 'logs', 'requests', 'request_abc123.json'),
  );
});

test('managed engine fixture launches the fake TabbyAPI from the fake venv and exposes lifecycle observation files', async () => {
  const tempRoot = createManagedTempDir('siftkit-managed-launcher-fixture-');
  try {
    const managed = writeManagedEngineLauncher(tempRoot, 12345, 'fixture-model', {
      initialUnloadedModelProbeCount: 2,
      deferredLogLine: 'deferred fixture log',
    });

    assert.equal(managed.engine.PythonPath, managed.pythonPath);
    assert.equal(managed.engine.Entrypoint, managed.scriptPath);
    assert.equal(managed.engine.ModelRoot, path.dirname(managed.modelPath));
    assert.equal(path.basename(managed.modelPath), 'fixture-model');
    assert.equal(fs.existsSync(path.join(managed.modelPath, 'config.json')), true);
    assert.equal(fs.existsSync(managed.probeShimPath), true);
    assert.equal(path.dirname(managed.modelProbeCountPath), tempRoot);
    assert.equal(path.dirname(managed.deferredLogMarkerPath), tempRoot);
    assert.equal(path.dirname(managed.pidFilePath), tempRoot);
  } finally {
    await removeDirectoryWithRetries(tempRoot);
  }
});
