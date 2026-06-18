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

export function extractTestNames(source: string): string[] {
  const names: string[] = [];
  const pattern = /^\s*(?:test|it)\(\s*(['"`])((?:\\.|(?!\1).)*)\1/gm;
  let match: RegExpExecArray | null = pattern.exec(source);
  while (match !== null) {
    names.push(match[2].replace(/\\(['"`\\])/g, '$1'));
    match = pattern.exec(source);
  }
  return names;
}

export function escapeForNamePattern(name: string): string {
  return `^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`;
}

export interface TestBranchSet {
  index: number;
  name: string;
  branchKeys: string[];
}

export interface DeletionCandidate {
  deleteIndex: number;
  deleteName: string;
  keepIndex: number;
  keepName: string;
  residualCount: number;
  residualKeys: string[];
}

export function buildCandidates(tests: TestBranchSet[], threshold: number): DeletionCandidate[] {
  const sets = tests.map((entry) => new Set(entry.branchKeys));
  const candidates: DeletionCandidate[] = [];
  for (let a = 0; a < tests.length; a++) {
    if (sets[a].size === 0) {
      continue;
    }
    for (let b = 0; b < tests.length; b++) {
      if (a === b || sets[b].size === 0) {
        continue;
      }
      const residualKeys: string[] = [];
      for (const key of sets[a]) {
        if (!sets[b].has(key)) {
          residualKeys.push(key);
        }
      }
      // Require B to subsume at least one of A's branches: a zero-overlap pair
      // (residual === all of A) is unrelated, never a near-duplicate.
      if (residualKeys.length < sets[a].size && residualKeys.length <= threshold) {
        candidates.push({
          deleteIndex: a,
          deleteName: tests[a].name,
          keepIndex: b,
          keepName: tests[b].name,
          residualCount: residualKeys.length,
          residualKeys,
        });
      }
    }
  }
  candidates.sort((left, right) => left.residualCount - right.residualCount);
  return candidates;
}

export function missingBranchKeys(deletedKeys: string[], coveringSets: string[][]): string[] {
  const union = new Set<string>();
  for (const set of coveringSets) {
    for (const key of set) {
      union.add(key);
    }
  }
  return deletedKeys.filter((key) => !union.has(key));
}
