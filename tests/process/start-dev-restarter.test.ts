/**
 * The dev restarter replaces `node --watch`, which restarted the status server whenever Windows
 * stamped a lazily read module's last-access time and force-killed it without a graceful shutdown.
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { findNearestSiftKitRepoRoot, moduleDirname } from '../../src/lib/paths.ts';
import { SHUTDOWN_MESSAGE } from '../../src/status-server/shutdown-message.ts';
import { createManagedTempDir } from '../helpers/temp-dirs.ts';

const WAIT_TIMEOUT_MS = 20_000;
const QUIET_PERIOD_MS = 1_500;
const FIXED_TIME_S = 1_700_000_000;

const FAKE_SERVER = [
  "process.stdout.write('started\\n');",
  "process.on('message', (message) => {",
  "  if (message && message.type === 'shutdown') { process.stdout.write('graceful-stop\\n'); process.exit(0); }",
  '});',
  'setInterval(() => {}, 1000);',
].join('\n');

const RESTARTER_BOOTSTRAP = 'void import(process.env.RESTARTER_URL).then((m) => m.superviseWithRestarts(JSON.parse(process.env.RESTARTER_OPTIONS)));';

function restarterUrl(): string {
  const repoRoot = findNearestSiftKitRepoRoot(moduleDirname(import.meta.url));
  if (repoRoot === null) throw new Error('Unable to locate the SiftKit package root.');
  return pathToFileURL(path.join(repoRoot, 'scripts', 'start-dev-restarter.ts')).href;
}

class RestarterProcess {
  readonly lines: string[] = [];
  readonly exit: Promise<number | null>;
  readonly child: ChildProcess;
  readonly sourceFile: string;

  constructor(child: ChildProcess, sourceFile: string) {
    this.child = child;
    this.sourceFile = sourceFile;
    let buffer = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      const parts = (buffer + chunk).split(/\r?\n/u);
      buffer = parts.pop() ?? '';
      this.lines.push(...parts.filter((line) => line.trim() === 'started' || line.trim() === 'graceful-stop'));
    });
    this.exit = new Promise((resolve) => { child.once('exit', (code) => { resolve(code); }); });
  }

  static async start(): Promise<RestarterProcess> {
    const root = createManagedTempDir('siftkit-restarter-');
    const sourceRoot = path.join(root, 'src');
    fs.mkdirSync(sourceRoot);
    const sourceFile = path.join(sourceRoot, 'module.ts');
    fs.writeFileSync(sourceFile, 'export const value = 1;\n');
    fs.utimesSync(sourceFile, FIXED_TIME_S, FIXED_TIME_S);
    const entry = path.join(root, 'server.mjs');
    fs.writeFileSync(entry, FAKE_SERVER);
    const child = spawn(process.execPath, ['-e', RESTARTER_BOOTSTRAP], {
      cwd: root,
      env: {
        ...process.env,
        RESTARTER_URL: restarterUrl(),
        RESTARTER_OPTIONS: JSON.stringify({ entry, args: [], roots: [sourceRoot], extensions: ['.ts'], stopTimeoutMs: 10_000 }),
      },
      stdio: ['ignore', 'pipe', 'inherit', 'ipc'],
    });
    const restarter = new RestarterProcess(child, sourceFile);
    await restarter.waitForLines(['started']);
    return restarter;
  }

  async waitForLines(expected: string[]): Promise<void> {
    const deadline = Date.now() + WAIT_TIMEOUT_MS;
    while (this.lines.length < expected.length) {
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${JSON.stringify(expected)}; saw ${JSON.stringify(this.lines)}`);
      await delay(25);
    }
    assert.deepEqual(this.lines, expected);
  }

  stop(): void {
    if (this.child.exitCode === null) this.child.kill('SIGKILL');
  }
}

test('a last-access touch does not restart the server; a real edit restarts it after a graceful stop', async (t) => {
  const restarter = await RestarterProcess.start();
  t.after(() => { restarter.stop(); });

  fs.utimesSync(restarter.sourceFile, FIXED_TIME_S + 3_600, FIXED_TIME_S);
  await delay(QUIET_PERIOD_MS);
  assert.deepEqual(restarter.lines, ['started'], 'an access-time stamp is not an edit');

  fs.writeFileSync(restarter.sourceFile, 'export const value = 2;\n');
  await restarter.waitForLines(['started', 'graceful-stop', 'started']);
});

test('a shutdown message stops the server gracefully, then the restarter exits cleanly', async (t) => {
  const restarter = await RestarterProcess.start();
  t.after(() => { restarter.stop(); });

  restarter.child.send(SHUTDOWN_MESSAGE);
  assert.equal(await restarter.exit, 0);
  assert.deepEqual(restarter.lines, ['started', 'graceful-stop']);
});
