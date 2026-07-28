import test from 'node:test';
import assert from 'node:assert/strict';

import { runCli } from '../src/cli/index.js';
import { PresetCatalog } from '../src/preset-catalog.js';
import { makeCaptureStream, withTestEnvAndServer } from './_test-helpers.js';

test('preset list shows builtin and custom cli-visible presets from the server', async () => {
  const catalog = PresetCatalog.createDefault();
  const summary = catalog.requireById('summary');
  const chat = catalog.requireById('chat');
  await withTestEnvAndServer(async () => {
    const stdout = makeCaptureStream();
    const stderr = makeCaptureStream();
    const code = await runCli({
      argv: ['preset', 'list'],
      stdout: stdout.stream,
      stderr: stderr.stream,
    });
    assert.equal(code, 0, stderr.read());
    assert.equal(stderr.read(), '');
    const output = stdout.read();
    assert.match(output, /^summary\tsummary\tsummary\tbuiltin\tSummary/mu);
    assert.match(output, /^custom-cli\tsummary\tsummary\tcustom\tCustom CLI/mu);
    assert.doesNotMatch(output, /^web-only\t/mu);
  }, {
    config: {
      Presets: [
        ...catalog.list(),
        {
          ...summary,
          id: 'custom-cli',
          label: 'Custom CLI',
          useForSummary: false,
          builtin: false,
          deletable: true,
        },
        {
          ...chat,
          id: 'web-only',
          label: 'Web Only',
          builtin: false,
          deletable: true,
        },
      ],
    },
  });
});
