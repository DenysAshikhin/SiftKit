import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { getDefaultConfigObject } from '../src/config/defaults.js';
import { invokeSummaryCore } from '../src/summary/core-runner.js';
import { createEmptyPresetSystemContext } from './helpers/empty-preset-system-context.js';
import { DEAD_CONFIG_SERVICE_URL, DEAD_STATUS_BACKEND_URL } from './helpers/dead-endpoints.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';

class TempSummaryEnv {
  readonly tempRoot = createManagedTempDir('siftkit-summary-core-runner-');
  private readonly previousCwd = process.cwd();
  private readonly previous = {
    USERPROFILE: process.env.USERPROFILE,
    sift_kit_status: process.env.sift_kit_status,
    SIFTKIT_STATUS_PATH: process.env.SIFTKIT_STATUS_PATH,
    SIFTKIT_CONFIG_PATH: process.env.SIFTKIT_CONFIG_PATH,
    SIFTKIT_IDLE_SUMMARY_DB_PATH: process.env.SIFTKIT_IDLE_SUMMARY_DB_PATH,
    SIFTKIT_TEST_PROVIDER: process.env.SIFTKIT_TEST_PROVIDER,
    SIFTKIT_CONFIG_SERVICE_URL: process.env.SIFTKIT_CONFIG_SERVICE_URL,
    SIFTKIT_STATUS_BACKEND_URL: process.env.SIFTKIT_STATUS_BACKEND_URL,
  };

  setup(): void {
    process.env.USERPROFILE = this.tempRoot;
    process.env.sift_kit_status = path.join(this.tempRoot, '.siftkit', 'status', 'inference.txt');
    process.env.SIFTKIT_STATUS_PATH = process.env.sift_kit_status;
    process.env.SIFTKIT_CONFIG_PATH = path.join(this.tempRoot, '.siftkit', 'config.json');
    process.env.SIFTKIT_IDLE_SUMMARY_DB_PATH = path.join(this.tempRoot, '.siftkit', 'status', 'idle-summary.sqlite');
    process.env.SIFTKIT_TEST_PROVIDER = 'mock';
    process.env.SIFTKIT_CONFIG_SERVICE_URL = DEAD_CONFIG_SERVICE_URL;
    process.env.SIFTKIT_STATUS_BACKEND_URL = DEAD_STATUS_BACKEND_URL;
    fs.writeFileSync(path.join(this.tempRoot, 'package.json'), JSON.stringify({ name: 'siftkit' }), 'utf8');
    process.chdir(this.tempRoot);
  }

  cleanup(): void {
    process.chdir(this.previousCwd);
    for (const [key, value] of Object.entries(this.previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    fs.rmSync(this.tempRoot, { force: true, recursive: true });
  }
}

test('invokeSummaryCore summarizes directly through the mock provider', async () => {
  const tempEnv = new TempSummaryEnv();
  try {
    tempEnv.setup();
    const config = getDefaultConfigObject();
    config.Runtime.LlamaCpp = {
      ...config.Runtime.LlamaCpp,
      NumCtx: 150_000,
    };
    const result = await invokeSummaryCore({
      requestId: 'summary-core-runner-test',
      slotId: null,
      question: 'summarize this',
      inputText: 'Build output: all tests passed.',
      images: [],
      format: 'text',
      policyProfile: 'general',
      backend: 'mock',
      model: 'mock-model',
      config,
      rawReviewRequired: false,
      sourceKind: 'standalone',
      presetPromptPrefix: '',
      additionalPromptPrefix: '',
      systemContext: createEmptyPresetSystemContext(),
    });

    assert.equal(result.decision.classification, 'summary');
    assert.equal(result.decision.rawReviewRequired, false);
    assert.equal(typeof result.decision.output, 'string');
    assert.ok(result.decision.output.length > 0);
    assert.notEqual(result.completionMetrics, null);
  } finally {
    tempEnv.cleanup();
  }
});
