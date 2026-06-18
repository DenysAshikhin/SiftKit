import * as path from 'node:path';

export interface IstanbulBranch {
  line: number;
  type: string;
}

export interface IstanbulFileCoverage {
  path: string;
  branchMap: Record<string, IstanbulBranch>;
  b: Record<string, number[]>;
  statementMap: Record<string, unknown>;
  s: Record<string, number>;
}

export type CoverageFinal = Record<string, IstanbulFileCoverage>;

export function collectCoveredBranchKeys(coverage: CoverageFinal, repoRoot: string): Set<string> {
  const keys = new Set<string>();
  for (const fileCoverage of Object.values(coverage)) {
    const relPath = path.relative(repoRoot, fileCoverage.path).replace(/\\/g, '/');
    if (!relPath.startsWith('src/')) {
      continue;
    }
    for (const [branchId, counts] of Object.entries(fileCoverage.b)) {
      for (let pathIndex = 0; pathIndex < counts.length; pathIndex++) {
        if (counts[pathIndex] > 0) {
          keys.add(`${relPath}|${branchId}|${pathIndex}`);
        }
      }
    }
  }
  return keys;
}
