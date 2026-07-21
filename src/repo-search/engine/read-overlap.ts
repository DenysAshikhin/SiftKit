import { z } from '../../lib/zod.js';

export type ReadRange = {
  start: number;
  end: number;
};

export type FileReadState = {
  /** Line ranges already returned to the model, merged and sorted. */
  mergedReturnedRanges: ReadRange[];
  totalLinesRead: number;
  uniqueLinesRead: number;
  overlapLines: number;
};

export const ReadOverlapSummarySchema = z.object({
  byFile: z.array(z.object({
    pathKey: z.string(),
    totalLinesRead: z.number(),
    uniqueLinesRead: z.number(),
    overlapLines: z.number(),
    overlapRatePct: z.number(),
  })),
  totalLinesRead: z.number(),
  totalUniqueLinesRead: z.number(),
  totalOverlapLines: z.number(),
  overlapRatePct: z.number(),
});
export type ReadOverlapSummary = z.infer<typeof ReadOverlapSummarySchema>;

function normalizeRange(range: ReadRange): ReadRange {
  const start = Math.max(0, Math.floor(Number(range.start) || 0));
  const end = Math.max(start, Math.floor(Number(range.end) || 0));
  return { start, end };
}

function intersectionLength(a: ReadRange, b: ReadRange): number {
  const normalizedA = normalizeRange(a);
  const normalizedB = normalizeRange(b);
  const intersectionStart = Math.max(normalizedA.start, normalizedB.start);
  const intersectionEnd = Math.min(normalizedA.end, normalizedB.end);
  return intersectionEnd > intersectionStart ? (intersectionEnd - intersectionStart) : 0;
}

export function overlapWithRanges(ranges: ReadRange[], next: ReadRange): number {
  const normalizedNext = normalizeRange(next);
  let overlapLines = 0;
  for (const range of ranges) {
    overlapLines += intersectionLength(range, normalizedNext);
  }
  return overlapLines;
}

export function mergeRange(ranges: ReadRange[], next: ReadRange): ReadRange[] {
  const normalizedNext = normalizeRange(next);
  if (normalizedNext.end <= normalizedNext.start) {
    return [...ranges];
  }
  const sortedRanges = [...ranges.map(normalizeRange), normalizedNext]
    .filter((range) => range.end > range.start)
    .sort((left, right) => (left.start - right.start) || (left.end - right.end));
  if (sortedRanges.length === 0) {
    return [];
  }
  const merged: ReadRange[] = [];
  for (const currentRange of sortedRanges) {
    const lastRange = merged[merged.length - 1];
    if (!lastRange || currentRange.start > lastRange.end) {
      merged.push({ ...currentRange });
      continue;
    }
    if (currentRange.end > lastRange.end) {
      lastRange.end = currentRange.end;
    }
  }
  return merged;
}

export function getOrCreateFileReadState(fileReadStateByPath: Map<string, FileReadState>, pathKey: string): FileReadState {
  const existingState = fileReadStateByPath.get(pathKey);
  if (existingState) {
    return existingState;
  }
  const createdState: FileReadState = {
    mergedReturnedRanges: [],
    totalLinesRead: 0,
    uniqueLinesRead: 0,
    overlapLines: 0,
  };
  fileReadStateByPath.set(pathKey, createdState);
  return createdState;
}

export function buildReadOverlapSummary(fileReadStateByPath: Map<string, FileReadState>): ReadOverlapSummary {
  const byFile = Array.from(fileReadStateByPath.entries())
    .map(([pathKey, state]) => {
      const totalLinesRead = Number(state.totalLinesRead || 0);
      const uniqueLinesRead = Number(state.uniqueLinesRead || 0);
      const overlapLines = Number(state.overlapLines || 0);
      const overlapRatePct = totalLinesRead > 0 ? Number(((overlapLines / totalLinesRead) * 100).toFixed(2)) : 0;
      return {
        pathKey,
        totalLinesRead,
        uniqueLinesRead,
        overlapLines,
        overlapRatePct,
      };
    })
    .sort((left, right) => left.pathKey.localeCompare(right.pathKey));
  const totalLinesRead = byFile.reduce((sum, item) => sum + item.totalLinesRead, 0);
  const totalUniqueLinesRead = byFile.reduce((sum, item) => sum + item.uniqueLinesRead, 0);
  const totalOverlapLines = byFile.reduce((sum, item) => sum + item.overlapLines, 0);
  const overlapRatePct = totalLinesRead > 0 ? Number(((totalOverlapLines / totalLinesRead) * 100).toFixed(2)) : 0;
  return {
    byFile,
    totalLinesRead,
    totalUniqueLinesRead,
    totalOverlapLines,
    overlapRatePct,
  };
}

export function mergeReadOverlapSummaries(summaries: Array<ReadOverlapSummary | null | undefined>): ReadOverlapSummary {
  const byFileAccumulator = new Map<string, { totalLinesRead: number; uniqueLinesRead: number; overlapLines: number }>();
  for (const summary of summaries) {
    if (!summary) {
      continue;
    }
    for (const item of summary.byFile || []) {
      const key = String(item.pathKey || '');
      if (!key) {
        continue;
      }
      const existing = byFileAccumulator.get(key) || { totalLinesRead: 0, uniqueLinesRead: 0, overlapLines: 0 };
      existing.totalLinesRead += Number(item.totalLinesRead || 0);
      existing.uniqueLinesRead += Number(item.uniqueLinesRead || 0);
      existing.overlapLines += Number(item.overlapLines || 0);
      byFileAccumulator.set(key, existing);
    }
  }
  const byFile = Array.from(byFileAccumulator.entries())
    .map(([pathKey, totals]) => ({
      pathKey,
      totalLinesRead: totals.totalLinesRead,
      uniqueLinesRead: totals.uniqueLinesRead,
      overlapLines: totals.overlapLines,
      overlapRatePct: totals.totalLinesRead > 0 ? Number(((totals.overlapLines / totals.totalLinesRead) * 100).toFixed(2)) : 0,
    }))
    .sort((left, right) => left.pathKey.localeCompare(right.pathKey));
  const totalLinesRead = byFile.reduce((sum, item) => sum + item.totalLinesRead, 0);
  const totalUniqueLinesRead = byFile.reduce((sum, item) => sum + item.uniqueLinesRead, 0);
  const totalOverlapLines = byFile.reduce((sum, item) => sum + item.overlapLines, 0);
  const overlapRatePct = totalLinesRead > 0 ? Number(((totalOverlapLines / totalLinesRead) * 100).toFixed(2)) : 0;
  return {
    byFile,
    totalLinesRead,
    totalUniqueLinesRead,
    totalOverlapLines,
    overlapRatePct,
  };
}
