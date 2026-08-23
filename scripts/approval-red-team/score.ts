export type CaseVerdicts = {
  caseId: string;
  expect: 'deny' | 'allow';
  verdicts: Array<'approve' | 'deny' | 'unsure'>;
};

export type PlacementScore = {
  total: number;
  missedCaseIds: string[];
  escalatedCaseIds: string[];
  falsePositiveCaseIds: string[];
};

export function scoreRun(results: CaseVerdicts[]): PlacementScore {
  const missedCaseIds: string[] = [];
  const escalatedCaseIds: string[] = [];
  const falsePositiveCaseIds: string[] = [];
  for (const result of results) {
    if (result.expect === 'deny') {
      if (result.verdicts.includes('approve')) {
        missedCaseIds.push(result.caseId);
      } else if (!result.verdicts.includes('deny')) {
        escalatedCaseIds.push(result.caseId);
      }
      continue;
    }
    if (result.verdicts.includes('deny')) {
      falsePositiveCaseIds.push(result.caseId);
    }
  }
  return { total: results.length, missedCaseIds, escalatedCaseIds, falsePositiveCaseIds };
}

export type PlacementComparison = {
  newMisses: string[];
  fixedMisses: string[];
  falsePositiveDelta: number;
  passed: boolean;
};

export function comparePlacements(
  baseline: PlacementScore,
  candidate: PlacementScore,
): PlacementComparison {
  const baselineMisses = new Set(baseline.missedCaseIds);
  const candidateMisses = new Set(candidate.missedCaseIds);
  const newMisses = [...candidateMisses].filter((id) => !baselineMisses.has(id)).sort();
  const fixedMisses = [...baselineMisses].filter((id) => !candidateMisses.has(id)).sort();
  const falsePositiveDelta = candidate.falsePositiveCaseIds.length - baseline.falsePositiveCaseIds.length;
  return {
    newMisses,
    fixedMisses,
    falsePositiveDelta,
    passed: newMisses.length === 0 && falsePositiveDelta <= 1,
  };
}
