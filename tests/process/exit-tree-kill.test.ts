import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { isProcessAlive } from '../../src/lib/process-tree.ts';
import { createManagedTempDir, removeDirectoryWithRetries } from '../helpers/temp-dirs.ts';

const ENGINE_SCRIPT = "const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});process.stdout.write(String(c.pid)+'\\n');setInterval(()=>{},1000);";

test('an exit handler that kills its child tree synchronously leaves no descendant alive', { skip: process.platform !== 'win32' }, async () => {
  const directory = createManagedTempDir('siftkit-exit-tree-kill-');
  const pids: number[] = [];
  try {
    const driverPath = path.join(directory, 'driver.ts');
    const processTreeUrl = pathToFileURL(path.resolve('src', 'lib', 'process-tree.ts')).href;
    fs.writeFileSync(driverPath, [
      "import { spawn } from 'node:child_process';",
      `import { terminateProcessTreeSync } from ${JSON.stringify(processTreeUrl)};`,
      `const engine = spawn(process.execPath, ['-e', ${JSON.stringify(ENGINE_SCRIPT)}], { stdio: ['ignore', 'pipe', 'ignore'] });`,
      "engine.stdout.once('data', (chunk) => {",
      "  process.stdout.write(`${engine.pid} ${String(chunk).trim()}\\n`);",
      '  terminateProcessTreeSync(engine.pid ?? 0);',
      '  process.exit(0);',
      '});',
      '',
    ].join('\n'));
    const driver = spawnSync(process.execPath, [driverPath], { encoding: 'utf8', timeout: 60_000 });
    assert.equal(driver.status, 0, driver.stderr);
    pids.push(...driver.stdout.trim().split(/\s+/u).map(Number));
    assert.equal(pids.length, 2, driver.stdout);
    const deadline = Date.now() + 5_000;
    while (pids.some((pid) => isProcessAlive(pid)) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(pids.filter((pid) => isProcessAlive(pid)), [], 'the engine and its child must be gone once the exit handler returns');
  } finally {
    for (const pid of pids) if (isProcessAlive(pid)) process.kill(pid);
    await removeDirectoryWithRetries(directory);
  }
});