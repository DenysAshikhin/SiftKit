import test from 'node:test';
import assert from 'node:assert/strict';

import { runCli } from '../src/cli/index.js';
import { makeCaptureStream, withTestEnvAndServer } from './_test-helpers.js';

test('preset list shows builtin and custom cli-visible presets from the server', async () => {
  await withTestEnvAndServer(async () => {
    const stdout = makeCaptureStream();
    const stderr = makeCaptureStream();
    const code = await runCli({
      argv: ['preset', 'list'],
      stdout: stdout.stream,
      stderr: stderr.stream,
    });
    assert.equal(code, 0);
    assert.equal(stderr.read(), '');
    const output = stdout.read();
    assert.match(output, /^summary\tsummary\tsummary\tbuiltin\tSummary/mu);
    assert.match(output, /^custom-cli\tsummary\tsummary\tcustom\tCustom CLI/mu);
    assert.doesNotMatch(output, /^web-only\t/mu);
  }, {
    config: {
      Presets: [
        { id: 'summary', label: 'Summary', surfaces: ['cli'] },
        { id: 'custom-cli', label: 'Custom CLI', executionFamily: 'summary', surfaces: ['cli'] },
        { id: 'web-only', label: 'Web Only', executionFamily: 'chat', surfaces: ['web'] },
      ],
    },
  });
});
