import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { ChildProcessEngineLauncher, type EngineProcess } from '../../src/status-server/engine-process.js';
import { createManagedTempDir } from '../helpers/temp-dirs.js';

function readStream(stream: NodeJS.ReadableStream | null): Promise<string> {
  if (!stream) throw new Error('The engine process has no output pipe.');
  return new Promise((resolve, reject) => {
    let text = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => { text += chunk; });
    stream.on('end', () => resolve(text));
    stream.on('error', reject);
  });
}

function waitForExit(engineProcess: EngineProcess): Promise<number | null> {
  return new Promise((resolve) => engineProcess.once('exit', (code) => resolve(code)));
}

test('the child-process launcher runs the command in its directory with exactly the given environment', async () => {
  const root = createManagedTempDir('siftkit-engine-launch-');
  const scriptPath = path.join(root, 'engine.cjs');
  fs.writeFileSync(scriptPath, [
    "process.stdout.write(JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2), marker: process.env.ENGINE_MARKER ?? null, inherited: process.env.ENGINE_ABSENT ?? null }));",
    "process.stderr.write('engine-stderr');",
  ].join('\n'), 'utf8');
  process.env.ENGINE_ABSENT = 'parent-only';
  try {
    const engineProcess = new ChildProcessEngineLauncher().launch({
      command: process.execPath,
      args: [scriptPath, '--flag'],
      workingDirectory: root,
      environment: { SystemRoot: process.env.SystemRoot, ENGINE_MARKER: 'launched' },
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      readStream(engineProcess.stdout),
      readStream(engineProcess.stderr),
      waitForExit(engineProcess),
    ]);
    assert.equal(exitCode, 0);
    assert.deepEqual(JSON.parse(stdout), { cwd: root, args: ['--flag'], marker: 'launched', inherited: null });
    assert.equal(stderr, 'engine-stderr');
  } finally {
    delete process.env.ENGINE_ABSENT;
  }
});

test('the child-process launcher terminates an engine that never exits on its own', async () => {
  const root = createManagedTempDir('siftkit-engine-terminate-');
  const launcher = new ChildProcessEngineLauncher();
  const engineProcess = launcher.launch({
    command: process.execPath,
    args: ['-e', "process.stdout.write('ready'); setInterval(() => {}, 1000);"],
    workingDirectory: root,
    environment: { SystemRoot: process.env.SystemRoot },
  });
  const exited = waitForExit(engineProcess);
  await new Promise<void>((resolve) => engineProcess.stdout?.once('data', () => resolve()));
  launcher.terminate(engineProcess);
  await exited;
  assert.notEqual(engineProcess.exitCode, null);
});
