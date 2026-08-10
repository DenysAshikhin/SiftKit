import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

import { isProcessAlive } from '../../src/lib/process-tree.js';
import { createManagedTempDir } from './temp-dirs.js';

export { isProcessAlive };

/** How long both processes would live if nothing terminated them. */
export const PROCESS_LIFETIME_MS = 20_000;

const PROCESS_START_WAIT_TIMEOUT_MS = 10_000;
const PROCESS_EXIT_WAIT_TIMEOUT_MS = 5_000;
const PROCESS_POLL_INTERVAL_MS = 20;
const ProcessIdSchema = z.coerce.number().int().positive();

export type ProcessTreeFixture = {
  /** Node script that spawns a grandchild inheriting stdio, then idles. */
  parentScript: string;
  /** Written by the parent immediately after spawning its grandchild. */
  grandchildPidPath: string;
  waitForGrandchildPid: () => Promise<number>;
  waitForProcessExit: (pid: number) => Promise<void>;
};

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function waitForGrandchildPidFile(pidPath: string): Promise<number> {
  const deadline = Date.now() + PROCESS_START_WAIT_TIMEOUT_MS;
  while (!fs.existsSync(pidPath)) {
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out after ${PROCESS_START_WAIT_TIMEOUT_MS}ms waiting for grandchild PID file: ${pidPath}`,
      );
    }
    await sleep(PROCESS_POLL_INTERVAL_MS);
  }
  const parsed = ProcessIdSchema.safeParse(fs.readFileSync(pidPath, 'utf8').trim());
  if (!parsed.success) {
    throw new Error(`Grandchild PID file is malformed: ${pidPath}`);
  }
  return parsed.data;
}

export async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + PROCESS_EXIT_WAIT_TIMEOUT_MS;
  while (isProcessAlive(pid)) {
    if (Date.now() >= deadline) {
      throw new Error(`Process ${pid} remained alive after ${PROCESS_EXIT_WAIT_TIMEOUT_MS}ms.`);
    }
    await sleep(PROCESS_POLL_INTERVAL_MS);
  }
}

/**
 * Builds a process tree whose grandchild inherits the captured stdio pipes and outlives its parent.
 * This is the shape that froze a run when only the direct child was terminated.
 */
export function createProcessTreeFixture(namePrefix: string): ProcessTreeFixture {
  const root = createManagedTempDir(namePrefix);
  const grandchildPidPath = path.join(root, 'grandchild.pid');
  const grandchildScript = path.join(root, 'grandchild.js');
  const parentScript = path.join(root, 'parent.js');
  fs.writeFileSync(
    grandchildScript,
    `setTimeout(() => {}, ${PROCESS_LIFETIME_MS});\n`,
    'utf8',
  );
  fs.writeFileSync(
    parentScript,
    [
      "const fs = require('node:fs');",
      "const { spawn } = require('node:child_process');",
      `const grandchild = spawn(process.execPath, [${JSON.stringify(grandchildScript)}], { stdio: 'inherit' });`,
      "if (grandchild.pid === undefined) throw new Error('Grandchild process did not expose a PID.');",
      `fs.writeFileSync(${JSON.stringify(grandchildPidPath)}, String(grandchild.pid), 'utf8');`,
      `setTimeout(() => {}, ${PROCESS_LIFETIME_MS});`,
    ].join('\n'),
    'utf8',
  );
  return {
    parentScript,
    grandchildPidPath,
    waitForGrandchildPid: () => waitForGrandchildPidFile(grandchildPidPath),
    waitForProcessExit,
  };
}
