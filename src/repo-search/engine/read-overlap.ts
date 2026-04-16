import type { ToolTypeStats } from '../../status-server/metrics.js';

export const REPEATED_LINE_READ_MIN_RATIO = 0.10;
export const DEFAULT_LINE_READ_AVG_TOKENS_PER_LINE = 8.0;
export const LINE_READ_ROUNDING_STEP = 10;

type ParsedGetContentReadWindow = {
  pathKey: string;
  pathExpression: string;
  requestedSkip: number;
  requestedFirst: number;
  requestedStart: number;
  requestedEnd: number;
  hasExplicitSkip: boolean;
};

export type LineReadAdjustment = {
  executedCommand: string;
  requestedStart: number;
  requestedEnd: number;
  adjustedStart: number;
  adjustedEnd: number;
  minLinesFromCap: number;
  perToolCapTokens: number;
  reason: string;
};

export type ReadRange = {
  start: number;
  end: number;
};

type ReadWindow = {
  turn: number;
  requestedStart: number;
  requestedEnd: number;
  executedStart: number;
  executedEnd: number;
  adjusted: boolean;
};

export type FileReadState = {
  windows: ReadWindow[];
  mergedExecutedRanges: ReadRange[];
  totalLinesRead: number;
  uniqueLinesRead: number;
  overlapLines: number;
};

export type ReadOverlapSummary = {
  byFile: Array<{
    pathKey: string;
    totalLinesRead: number;
    uniqueLinesRead: number;
    overlapLines: number;
    overlapRatePct: number;
  }>;
  totalLinesRead: number;
  totalUniqueLinesRead: number;
  totalOverlapLines: number;
  overlapRatePct: number;
};

function tokenizeShellLike(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  for (let index = 0; index < input.length; index += 1) {
    const ch = input[index];
    if (ch === '\'' && !inDouble) {
      inSingle = !inSingle;
      current += ch;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      current += ch;
      continue;
    }
    if (/\s/u.test(ch) && !inSingle && !inDouble) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }
  if (current) {
    tokens.push(current);
  }
  return tokens;
}

function stripOuterQuotes(value: string): string {
  const trimmed = String(value || '').trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith('\'') && trimmed.endsWith('\''))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function normalizeReadPathKey(pathValue: string): string {
  return stripOuterQuotes(pathValue).replace(/\//gu, '\\').toLowerCase();
}

function roundToNearestStep(value: number, step: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(step) || step <= 0) {
    return Math.floor(Number(value) || 0);
  }
  return Math.round(value / step) * step;
}

function roundUpToStep(value: number, step: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(step) || step <= 0) {
    return Math.floor(Number(value) || 0);
  }
  return Math.ceil(value / step) * step;
}

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
    windows: [],
    mergedExecutedRanges: [],
    totalLinesRead: 0,
    uniqueLinesRead: 0,
    overlapLines: 0,
  };
  fileReadStateByPath.set(pathKey, createdState);
  return createdState;
}

export function getPreviousExecutedMaxEnd(fileReadState: FileReadState): number {
  if (fileReadState.mergedExecutedRanges.length === 0) {
    return 0;
  }
  return Math.max(...fileReadState.mergedExecutedRanges.map((range) => range.end));
}

export function computeAdjustedReadWindow(input: {
  requestedStart: number;
  requestedEnd: number;
  minLinesFromCap: number;
  roundingStep: number;
  previousExecutedMaxEnd: number;
}): { start: number; end: number; adjusted: boolean; reason: string } {
  const requestedStart = Math.max(0, Math.floor(Number(input.requestedStart) || 0));
  const requestedEnd = Math.max(requestedStart + 1, Math.floor(Number(input.requestedEnd) || 0));
  const requestedLength = Math.max(1, requestedEnd - requestedStart);
  const nonOverlapStart = Math.max(requestedStart, Math.floor(Number(input.previousExecutedMaxEnd) || 0));
  const targetLength = Math.max(requestedLength, Math.max(1, Math.floor(Number(input.minLinesFromCap) || 0)));
  let start = Math.max(0, roundUpToStep(nonOverlapStart, input.roundingStep));
  if (start < nonOverlapStart) {
    start = nonOverlapStart;
  }
  let end = roundToNearestStep(start + targetLength, input.roundingStep);
  if (end <= start) {
    end = start + Math.max(1, Math.floor(Number(input.roundingStep) || 1));
  }
  while (end - start < targetLength) {
    end += Math.max(1, Math.floor(Number(input.roundingStep) || 1));
  }
  return {
    start,
    end,
    adjusted: start !== requestedStart || end !== requestedEnd,
    reason: 'repeated-read-no-overlap',
  };
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

export function parseGetContentReadWindowCommand(command: string): ParsedGetContentReadWindow | null {
  const trimmed = String(command || '').trim();
  const match = /^get-content\s+(.+?)\s*\|\s*select-object\s+(.+)$/iu.exec(trimmed);
  if (!match) {
    return null;
  }
  const pathExpression = String(match[1] || '').trim();
  const selectExpression = String(match[2] || '').trim();
  if (!pathExpression || !selectExpression) {
    return null;
  }

  const pathTokens = tokenizeShellLike(pathExpression);
  if (!pathTokens.length) {
    return null;
  }
  let pathToken = '';
  if (pathTokens[0].startsWith('-')) {
    pathToken = pathTokens[1] || '';
  } else {
    pathToken = pathTokens[0];
  }
  const pathKey = normalizeReadPathKey(pathToken);
  if (!pathKey) {
    return null;
  }

  const selectTokens = tokenizeShellLike(selectExpression);
  let requestedFirst: number | null = null;
  let requestedSkip = 0;
  let hasExplicitSkip = false;
  for (let index = 0; index < selectTokens.length; index += 1) {
    const token = selectTokens[index].toLowerCase();
    if (token === '-first') {
      requestedFirst = Number(selectTokens[index + 1]);
      index += 1;
      continue;
    }
    if (token === '-skip') {
      requestedSkip = Number(selectTokens[index + 1]);
      hasExplicitSkip = true;
      index += 1;
    }
  }
  if (!Number.isFinite(requestedFirst)) {
    return null;
  }
  requestedSkip = Math.max(0, Math.floor(Number(requestedSkip) || 0));
  const first = Math.max(1, Math.floor(Number(requestedFirst) || 0));
  const requestedStart = requestedSkip;
  const requestedEnd = requestedSkip + first;
  return {
    pathKey,
    pathExpression,
    requestedSkip,
    requestedFirst: first,
    requestedStart,
    requestedEnd,
    hasExplicitSkip,
  };
}

export function buildGetContentReadWindowCommand(
  pathExpression: string,
  skip: number,
  first: number,
  hasExplicitSkip: boolean,
): string {
  const boundedSkip = Math.max(0, Math.floor(Number(skip) || 0));
  const boundedFirst = Math.max(1, Math.floor(Number(first) || 0));
  if (!hasExplicitSkip && boundedSkip === 0) {
    return `Get-Content ${pathExpression} | Select-Object -First ${boundedFirst}`;
  }
  return `Get-Content ${pathExpression} | Select-Object -Skip ${boundedSkip} -First ${boundedFirst}`;
}

export function resolveAvgTokensPerLine(
  currentStats: ToolTypeStats | null | undefined,
  historicalStats: ToolTypeStats | null | undefined,
): number {
  const currentCalls = Number(currentStats?.lineReadCalls || 0);
  const currentLines = Number(currentStats?.lineReadLinesTotal || 0);
  const currentTokens = Number(currentStats?.lineReadTokensTotal || 0);
  if (currentCalls > 0 && currentLines > 0 && currentTokens > 0) {
    const currentAvg = currentTokens / currentLines;
    if (Number.isFinite(currentAvg) && currentAvg > 0) {
      return currentAvg;
    }
  }

  const historicalCalls = Number(historicalStats?.lineReadCalls || 0);
  const historicalLines = Number(historicalStats?.lineReadLinesTotal || 0);
  const historicalTokens = Number(historicalStats?.lineReadTokensTotal || 0);
  if (historicalCalls > 0 && historicalLines > 0 && historicalTokens > 0) {
    const historicalAvg = historicalTokens / historicalLines;
    if (Number.isFinite(historicalAvg) && historicalAvg > 0) {
      return historicalAvg;
    }
  }

  return DEFAULT_LINE_READ_AVG_TOKENS_PER_LINE;
}
