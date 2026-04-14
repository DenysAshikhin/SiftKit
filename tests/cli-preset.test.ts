import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { runCli } from '../dist/cli/index.js';
import { makeCaptureStream } from './_test-helpers.js';
import { readConfig, writeConfig } from '../dist/status-server/config-store.js';
import { closeRuntimeDatabase } from '../dist/state/runtime-db.js';

function withTempRepo(fn: (repoRoot: string) => Promise<void> | void): Promise<void> {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-cli-preset-'));
  const previousCwd = process.cwd();
  fs.writeFileSync(
    path.join(tempRoot, 'package.json'),
    JSON.stringify({ name: 'siftkit', version: '0.1.0' }, null, 2),
    'utf8',
  );
  process.chdir(tempRoot);
  return Promise.resolve()
    .then(() => fn(tempRoot))
    .finally(() => {
      closeRuntimeDatabase();
      process.chdir(previousCwd);
      fs.rmSync(tempRoot, { recursive: true, force: true });
    });
}

test('preset list shows builtin and custom cli-visible presets', async () => {
  await withTempRepo(async (repoRoot) => {
    const configPath = path.join(repoRoot, '.siftkit', 'runtime.sqlite');
    const config = readConfig(configPath);
    config.Presets = [
      { id: 'summary', label: 'Summary', surfaces: ['cli'] },
      { id: 'custom-cli', label: 'Custom CLI', executionFamily: 'summary', surfaces: ['cli'] },
      { id: 'web-only', label: 'Web Only', executionFamily: 'chat', surfaces: ['web'] },
    ];
    writeConfig(configPath, config);

    const stdout = makeCaptureStream();
    const stderr = makeCaptureStream();
    const code = await runCli({
      argv: ['preset', 'list'],
      stdout: stdout.stream,
      stderr: stderr.stream,
    });
    assert.equal(code, 0);
    const output = stdout.read();
    assert.match(output, /^summary\tsummary\tbuiltin\tSummary/mu);
    assert.match(output, /^custom-cli\tsummary\tcustom\tCustom CLI/mu);
    assert.doesNotMatch(output, /^web-only\t/mu);
  });
});
