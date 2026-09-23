import test, { before, after } from 'node:test';
import { IsolatedRuntime } from '../helpers/isolated-runtime.js';

const isolatedRuntime = new IsolatedRuntime();
before(() => isolatedRuntime.start());
after(() => isolatedRuntime.close());
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';


import {
  runTaskLoop,
} from '../../src/repo-search/engine.js';
import { mockOfflineSiftConfig } from '../helpers/mock-config.js';
import { createEmptyPresetSystemContext } from '../helpers/empty-preset-system-context.js';
import { createManagedTempDir } from '../helpers/temp-dirs.js';
import { createMockLoopDefaults } from '../helpers/mock-loop-defaults.js';
import { resolveRepoSearchPlannerToolDefinitions } from '../../src/repo-search/planner-protocol.js';
import { TEST_THROUGHPUT_AUDIT_OPERATION } from '../_test-helpers.js';

const MOCK_LOOP_DEFAULTS = createMockLoopDefaults('siftkit-mock-loop-');

test('runTaskLoop passes a mixed-quote grep regex through to rg without shell mangling', async () => {
  const repoRoot = createManagedTempDir('siftkit-repo-search-ignore-');
  fs.writeFileSync(path.join(repoRoot, '.gitignore'), '', 'utf8');
  fs.mkdirSync(path.join(repoRoot, 'src'));
  fs.writeFileSync(
    path.join(repoRoot, 'src', 'example.ts'),
    'import { BridgeClient } from "../bridge/bridge.facade.js";\n',
    'utf8',
  );

  const result = await runTaskLoop(
    {
      id: 'task-native-grep-mixed-quote',
      question: 'Find relative imports.',
    },
    {
      throughputAudit: TEST_THROUGHPUT_AUDIT_OPERATION,
      plannerToolDefinitions: resolveRepoSearchPlannerToolDefinitions(),
      runtimeProfile: MOCK_LOOP_DEFAULTS.runtimeProfile,
      repoRoot,
      systemContext: createEmptyPresetSystemContext(),
      config: mockOfflineSiftConfig(),
      model: 'mock-model',
      baseUrl: 'http://127.0.0.1:8097',
      maxTurns: 2,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 0,
      mockResponses: [
        // The pattern carries both quote flavours; grep builds an rg argv directly,
        // so nothing re-quotes it on the way to the process.
        { toolCalls: [{ name: 'grep', arguments: { pattern: 'from [\'"]\\.\\./', path: 'src' } }] },
        { content: "done" },
        { content: '{"verdict":"pass","reason":"supported"}' },
      ],
    }
  );

  assert.equal(result.rejectedCalls, 0);
  assert.equal(result.nonZeroExits, 0);
  assert.match(result.commands[0]?.output || '', /BridgeClient/u);
  assert.equal(result.reason, 'finish');
});
