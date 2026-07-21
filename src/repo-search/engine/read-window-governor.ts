import {
  buildReadOverlapSummary,
  getOrCreateFileReadState,
  mergeRange,
  overlapWithRanges,
  type ReadRange,
  type ReadOverlapSummary,
  type FileReadState,
} from './read-overlap.js';

export type ReadExecutionMetrics = {
  overlapLines: number;
  newLinesCovered: number;
  cumulativeUniqueLines: number;
};

/**
 * Tracks which line ranges of which files have already been returned to the model, so `read` can
 * skip them (see planRead) and so the run can report a read-overlap rate.
 *
 * Overlap is expected to be near zero: planRead advances past already-returned ranges before the
 * read executes. A non-zero rate means ranges were returned by some path that bypassed that check.
 */
export class ReadWindowGovernor {
  private readonly fileReadStateByPath = new Map<string, FileReadState>();

  get stateMap(): Map<string, FileReadState> {
    return this.fileReadStateByPath;
  }

  /** Records the range actually returned to the model, after output fitting may have truncated it. */
  recordNativeRead(options: {
    pathKey: string;
    returnedStart: number;
    returnedEndExclusive: number;
  }): ReadExecutionMetrics {
    const fileReadState = getOrCreateFileReadState(this.fileReadStateByPath, options.pathKey);
    const returnedRange: ReadRange = { start: options.returnedStart, end: options.returnedEndExclusive };
    const linesRead = Math.max(0, returnedRange.end - returnedRange.start);
    const overlapLines = overlapWithRanges(fileReadState.mergedReturnedRanges, returnedRange);
    const newLinesCovered = Math.max(0, linesRead - overlapLines);
    fileReadState.totalLinesRead += linesRead;
    fileReadState.overlapLines += overlapLines;
    fileReadState.uniqueLinesRead += newLinesCovered;
    fileReadState.mergedReturnedRanges = mergeRange(fileReadState.mergedReturnedRanges, returnedRange);
    return { overlapLines, newLinesCovered, cumulativeUniqueLines: fileReadState.uniqueLinesRead };
  }

  summary(): ReadOverlapSummary {
    return buildReadOverlapSummary(this.fileReadStateByPath);
  }
}
