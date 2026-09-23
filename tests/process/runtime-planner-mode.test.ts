import test from 'node:test';
import assert from 'node:assert/strict';

import {
  fs,
  path,
  loadConfig,
  getChunkThresholdCharacters,
  buildOversizedTransitionsInput,
  getRequestLogsPath,
  withStubServerCapturingPlannerDebugDump,
  spawnProcess,
  withTempEnv,
  waitForAsyncExpectation,
} from '../_runtime-helpers.js';

const SIFTKIT_REPO_ROOT = process.cwd();

test('powershell shim preserves pipeline order for oversized planner input', async () => {
  await withTempEnv(async (tempRoot) => {
    await withStubServerCapturingPlannerDebugDump(async () => {
      const config = await loadConfig({ ensure: true });
      const threshold = getChunkThresholdCharacters(config);
      const inputPath = path.join(tempRoot, 'pipeline-transitions.json');
      fs.writeFileSync(inputPath, buildOversizedTransitionsInput(threshold + 1000), 'utf8');

      const shimPath = path.resolve(SIFTKIT_REPO_ROOT, 'bin', 'siftkit.ps1').replace(/'/gu, "''");
      const escapedInputPath = inputPath.replace(/'/gu, "''");
      const commandText = [
        `Get-Content -LiteralPath '${escapedInputPath}'`,
        '|',
        `& (Resolve-Path -LiteralPath '${shimPath}')`,
        "'Find all transitions in the Lumbridge Castle area.'",
        '--backend removed-engine',
        '--model mock-model',
      ].join(' ');
      const result = await spawnProcess('powershell.exe', [
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-Command', commandText,
      ], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          SIFTKIT_STATUS_BACKEND_URL: process.env.SIFTKIT_STATUS_BACKEND_URL,
          SIFTKIT_CONFIG_SERVICE_URL: process.env.SIFTKIT_CONFIG_SERVICE_URL,
        },
      });

      assert.equal(result.code, 0, result.stderr || result.stdout);
    }, {
      assistantContent(promptText, parsed, requestIndex) {
        if (requestIndex === 1) {
          return { toolCalls: [{ name: 'finish', arguments: { classification: 'summary', raw_review_required: false, output: 'planner succeeded' } }] };
        }

        throw new Error(`unexpected powershell shim request ${requestIndex}: ${String(promptText).slice(0, 120)}`);
      },
    });


    // The raw piped input lives once, in the summary_request artifact.
    await waitForAsyncExpectation(() => {
      const requestDumps = fs.readdirSync(getRequestLogsPath()).filter((entry) => /^request_.*\.json$/u.test(entry));
      assert.equal(requestDumps.length, 1);
      const requestDump = JSON.parse(fs.readFileSync(path.join(getRequestLogsPath(), requestDumps[0]), 'utf8'));
      assert.match(requestDump.inputText, /^\[/u);
      assert.doesNotMatch(requestDump.inputText, /^\]\r?\n\[/u);
    });
  });
});
