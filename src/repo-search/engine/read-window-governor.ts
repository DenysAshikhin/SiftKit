import type { ToolTypeStats } from '../../status-server/metrics.js';
import {
  buildGetContentReadWindowCommand,
  buildReadOverlapSummary,
  computeAdjustedReadWindow,
  getOrCreateFileReadState,
  getPreviousExecutedMaxEnd,
  type LineReadAdjustment,
  LINE_READ_ROUNDING_STEP,
  mergeRange,
  overlapWithRanges,
  type ParsedGetContentReadWindow,
  REPEATED_LINE_READ_MIN_RATIO,
  type ReadRange,
  type ReadOverlapSummary,
  resolveAvgTokensPerLine,
  type FileReadState,
} from './read-overlap.js';

export type ReadExecutionMetrics = {
  overlapLines: number;
  newLinesCovered: number;
  cumulativeUniqueLines: number;
};

export type PlannedReadAdjustment = {
  commandToRun: string;
  adjustment: LineReadAdjustment;
};

export class ReadWindowGovernor {
  private readonly fileReadCountByPath = new Map<string, number>();
  private readonly fileReadStateByPath = new Map<string, FileReadState>();

  get stateMap(): Map<string, FileReadState> {
    return this.fileReadStateByPath;
  }

  readCount(pathKey: string): number {
    return Number(this.fileReadCountByPath.get(pathKey) || 0);
  }

  planAdjustment(options: {
    parsedReadWindow: ParsedGetContentReadWindow;
    perToolCapTokens: number;
    currentGetContentStats: ToolTypeStats | null;
    historicalGetContentStats: ToolTypeStats | null;
    expandReads: boolean;
  }): PlannedReadAdjustment | null {
    const previousReadCount = this.readCount(options.parsedReadWindow.pathKey);
    if (previousReadCount < 1) {
      return null;
    }
    if (!options.expandReads) {
      return null;
    }
    const minTokensFromCap = Math.max(1, Math.ceil(options.perToolCapTokens * REPEATED_LINE_READ_MIN_RATIO));
    const avgTokensPerLine = resolveAvgTokensPerLine(options.currentGetContentStats, options.historicalGetContentStats);
    const minLinesFromCap = Math.max(1, Math.ceil(minTokensFromCap / avgTokensPerLine));
    const existingReadState = getOrCreateFileReadState(this.fileReadStateByPath, options.parsedReadWindow.pathKey);
    const previousReturnedMaxEnd = existingReadState.mergedReturnedRanges.length > 0
      ? Math.max(...existingReadState.mergedReturnedRanges.map((range) => range.end))
      : getPreviousExecutedMaxEnd(existingReadState);
    const adjustedWindow = computeAdjustedReadWindow({
      requestedStart: options.parsedReadWindow.requestedStart,
      requestedEnd: options.parsedReadWindow.requestedEnd,
      minLinesFromCap,
      roundingStep: LINE_READ_ROUNDING_STEP,
      previousExecutedMaxEnd: previousReturnedMaxEnd,
    });
    if (!adjustedWindow.adjusted) {
      return null;
    }
    const adjustedFirst = Math.max(1, adjustedWindow.end - adjustedWindow.start);
    const commandToRun = buildGetContentReadWindowCommand(
      options.parsedReadWindow.pathExpression,
      adjustedWindow.start,
      adjustedFirst,
      options.parsedReadWindow.hasExplicitSkip,
    );
    return {
      commandToRun,
      adjustment: {
        executedCommand: commandToRun,
        requestedStart: options.parsedReadWindow.requestedStart,
        requestedEnd: options.parsedReadWindow.requestedEnd,
        adjustedStart: adjustedWindow.start,
        adjustedEnd: adjustedWindow.end,
        minLinesFromCap,
        perToolCapTokens: options.perToolCapTokens,
        reason: adjustedWindow.reason,
      },
    };
  }

  recordExecution(options: {
    parsedReadWindow: ParsedGetContentReadWindow;
    executedReadWindow: ParsedGetContentReadWindow | null;
    turn: number;
    adjusted: boolean;
  }): ReadExecutionMetrics {
    this.fileReadCountByPath.set(
      options.parsedReadWindow.pathKey,
      this.readCount(options.parsedReadWindow.pathKey) + 1,
    );
    const metrics: ReadExecutionMetrics = { overlapLines: 0, newLinesCovered: 0, cumulativeUniqueLines: 0 };
    if (!options.executedReadWindow || options.executedReadWindow.pathKey !== options.parsedReadWindow.pathKey) {
      return metrics;
    }
    const fileReadState = getOrCreateFileReadState(this.fileReadStateByPath, options.parsedReadWindow.pathKey);
    const executedRange: ReadRange = {
      start: options.executedReadWindow.requestedStart,
      end: options.executedReadWindow.requestedEnd,
    };
    const linesRead = Math.max(0, executedRange.end - executedRange.start);
    metrics.overlapLines = overlapWithRanges(fileReadState.mergedExecutedRanges, executedRange);
    metrics.newLinesCovered = Math.max(0, linesRead - metrics.overlapLines);
    fileReadState.totalLinesRead += linesRead;
    fileReadState.overlapLines += metrics.overlapLines;
    fileReadState.uniqueLinesRead += metrics.newLinesCovered;
    fileReadState.mergedExecutedRanges = mergeRange(fileReadState.mergedExecutedRanges, executedRange);
    fileReadState.windows.push({
      turn: options.turn,
      requestedStart: options.parsedReadWindow.requestedStart,
      requestedEnd: options.parsedReadWindow.requestedEnd,
      executedStart: executedRange.start,
      executedEnd: executedRange.end,
      adjusted: options.adjusted,
    });
    metrics.cumulativeUniqueLines = fileReadState.uniqueLinesRead;
    return metrics;
  }

  applyFitTruncation(options: {
    parsedReadWindow: ParsedGetContentReadWindow;
    executedReadWindow: ParsedGetContentReadWindow;
    fittedReturnedSegmentCount: number | null;
    metrics: ReadExecutionMetrics;
  }): void {
    if (options.executedReadWindow.pathKey !== options.parsedReadWindow.pathKey) {
      return;
    }
    const fileReadState = getOrCreateFileReadState(this.fileReadStateByPath, options.parsedReadWindow.pathKey);
    const executedLineCount = Math.max(0, options.executedReadWindow.requestedEnd - options.executedReadWindow.requestedStart);
    const returnedLineCount = Math.min(
      executedLineCount,
      options.fittedReturnedSegmentCount ?? executedLineCount,
    );
    if (options.fittedReturnedSegmentCount !== null && returnedLineCount < executedLineCount) {
      const adjustedNewLinesCovered = Math.min(options.metrics.newLinesCovered, returnedLineCount);
      fileReadState.totalLinesRead += returnedLineCount - executedLineCount;
      fileReadState.uniqueLinesRead += adjustedNewLinesCovered - options.metrics.newLinesCovered;
      options.metrics.newLinesCovered = adjustedNewLinesCovered;
      options.metrics.cumulativeUniqueLines = fileReadState.uniqueLinesRead;
    }
    if (returnedLineCount > 0) {
      fileReadState.mergedReturnedRanges = mergeRange(fileReadState.mergedReturnedRanges, {
        start: options.executedReadWindow.requestedStart,
        end: options.executedReadWindow.requestedStart + returnedLineCount,
      });
    }
  }

  recordNativeReturnedRange(pathKey: string, range: ReadRange): void {
    const fileReadState = getOrCreateFileReadState(this.fileReadStateByPath, pathKey);
    fileReadState.mergedReturnedRanges = mergeRange(fileReadState.mergedReturnedRanges, range);
  }

  summary(): ReadOverlapSummary {
    return buildReadOverlapSummary(this.fileReadStateByPath);
  }
}
