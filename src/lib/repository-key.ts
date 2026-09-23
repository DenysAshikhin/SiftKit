import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

/** Canonical repository identity: real path, case-folded on Windows. A missing root fails loudly. */
export function canonicalRepositoryKey(repoRoot: string): string {
  const real = realpathSync.native(resolve(repoRoot));
  return process.platform === 'win32' ? real.toLowerCase() : real;
}
