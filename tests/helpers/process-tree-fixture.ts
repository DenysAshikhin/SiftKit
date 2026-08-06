import fs from 'node:fs';
import path from 'node:path';

import { createManagedTempDir } from './temp-dirs.js';

/** How long the grandchild waits before proving it survived. */
export const MARKER_DELAY_MS = 4_000;
/** How long both processes would live if nothing terminated them. */
export const PROCESS_LIFETIME_MS = 20_000;

export type ProcessTreeFixture = {
  /** Node script that spawns a grandchild inheriting stdio, then idles. */
  parentScript: string;
  /** Written by the grandchild after `MARKER_DELAY_MS`; its absence proves the tree died. */
  markerPath: string;
};

/**
 * Builds a process tree whose grandchild inherits the captured stdio pipes and outlives its parent.
 *
 * This is the shape that froze a run for 17 minutes: terminating only the direct child leaves the
 * grandchild holding stdout/stderr open, so `'close'` never fires and the capture promise never
 * settles. Both command runners are exercised against it.
 */
export function createProcessTreeFixture(namePrefix: string): ProcessTreeFixture {
  const root = createManagedTempDir(namePrefix);
  const markerPath = path.join(root, 'descendant-survived.txt');
  const grandchildScript = path.join(root, 'grandchild.js');
  const parentScript = path.join(root, 'parent.js');
  fs.writeFileSync(
    grandchildScript,
    `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'alive'), ${MARKER_DELAY_MS});\n`,
    'utf8',
  );
  fs.writeFileSync(
    parentScript,
    [
      `require('node:child_process').spawn(process.execPath, [${JSON.stringify(grandchildScript)}], { stdio: 'inherit' });`,
      `setTimeout(() => {}, ${PROCESS_LIFETIME_MS});`,
    ].join('\n'),
    'utf8',
  );
  return { parentScript, markerPath };
}
