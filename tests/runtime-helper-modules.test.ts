import test from 'node:test';
import assert from 'node:assert/strict';
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

// mergeConfig is a heterogeneous deep-merge that returns JsonValue; for the config-merge
// case the test exercises, the result carries the merged Runtime plus a Thresholds bag
// (with derived keys stripped). Validate that shape at the boundary so reads stay typed.
const MergedRuntimeConfigSchema = z
  .object({
    Runtime: z.object({ LlamaCpp: z.object({ BaseUrl: z.string() }).passthrough() }).passthrough(),
    Thresholds: JsonObjectSchema,
  })
  .passthrough();

test('runtime config helpers merge nested overrides and strip derived fields', () => {
  const config = getDefaultConfig();
  const merged = MergedRuntimeConfigSchema.parse(mergeConfig(config, {
    Runtime: {
      LlamaCpp: {
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

  assert.equal(merged.Runtime.LlamaCpp.BaseUrl, 'http://127.0.0.1:9999');
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
