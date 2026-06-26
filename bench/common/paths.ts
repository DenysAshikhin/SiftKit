import { findNearestSiftKitRepoRoot } from '../../src/lib/paths.js';

export function getRepoRoot(): string {
  const root = findNearestSiftKitRepoRoot(__dirname);
  if (root === null) {
    throw new Error('Unable to locate the SiftKit repo root from the benchmark harness.');
  }
  return root;
}
