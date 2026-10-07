import { findNearestSiftKitRepoRoot, moduleDirname } from '../../src/lib/paths.ts';

export function getRepoRoot(): string {
  const root = findNearestSiftKitRepoRoot(moduleDirname(import.meta.url));
  if (root === null) {
    throw new Error('Unable to locate the SiftKit repo root from the benchmark harness.');
  }
  return root;
}
