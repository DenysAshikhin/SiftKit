export type ToolOutputTruncationUnit = 'lines' | 'files' | 'results' | 'characters';

// Which end of the output survives truncation. 'head' keeps the first segments
// (correct for offset-based reads and search hits); 'tail' keeps the last
// segments (correct for command output whose verdict/errors land at the end).
export type ToolOutputKeep = 'head' | 'tail';

export type ToolOutputFitResult = {
  visibleText: string;
  returnedLineCount: number;
  truncatedLineCount: number;
  truncationReason: string | null;
};

export type ToolOutputFitInput = {
  headerText?: string;
  segments: readonly string[];
  separator: string;
  maxTokens: number;
  unit: ToolOutputTruncationUnit;
  keep: ToolOutputKeep;
};

export type ToolOutputTokenCounter = {
  countToolOutputTokens(text: string): Promise<number>;
};

export class ToolOutputFitter {
  private readonly tokenCounter: ToolOutputTokenCounter;

  constructor(tokenCounter: ToolOutputTokenCounter) {
    this.tokenCounter = tokenCounter;
  }

  async fitSegments(input: ToolOutputFitInput): Promise<ToolOutputFitResult> {
    const maxTokens = Math.max(1, Math.floor(input.maxTokens));
    const segments = [...input.segments];
    const totalCount = segments.length;
    if (totalCount === 0) {
      return {
        visibleText: String(input.headerText || '').trim(),
        returnedLineCount: 0,
        truncatedLineCount: 0,
        truncationReason: null,
      };
    }

    const fullText = this.buildCandidate(input, totalCount);
    if (await this.tokenCounter.countToolOutputTokens(fullText) <= maxTokens) {
      return {
        visibleText: fullText,
        returnedLineCount: totalCount,
        truncatedLineCount: 0,
        truncationReason: null,
      };
    }

    const truncationTargetTokens = Math.max(1, Math.floor(maxTokens * 0.5));
    let low = 0;
    let high = totalCount;
    let bestCount = 0;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const candidate = this.buildCandidate(input, mid);
      const tokenCount = await this.tokenCounter.countToolOutputTokens(candidate);
      if (tokenCount <= truncationTargetTokens) {
        bestCount = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    const visibleText = this.buildCandidate(input, bestCount);
    return {
      visibleText,
      returnedLineCount: bestCount,
      truncatedLineCount: totalCount - bestCount,
      truncationReason: 'per-tool context limit',
    };
  }

  private buildCandidate(input: ToolOutputFitInput, segmentCount: number): string {
    const parts: string[] = [];
    const headerText = String(input.headerText || '').trim();
    if (headerText) {
      parts.push(headerText);
    }
    const total = input.segments.length;
    const truncatedCount = total - segmentCount;
    const keepTail = input.keep === 'tail';
    const kept = keepTail
      ? input.segments.slice(total - segmentCount)
      : input.segments.slice(0, segmentCount);
    const notice = truncatedCount > 0
      ? `${truncatedCount} ${input.unit} truncated due to per-tool context limit.`
      : null;
    // Tail mode leads with the notice so the surviving tail (the summary) stays
    // last; head mode trails it after the surviving head.
    if (notice && keepTail) {
      parts.push(notice);
    }
    const body = kept.join(input.separator).trim();
    if (body) {
      parts.push(body);
    }
    if (notice && !keepTail) {
      parts.push(notice);
    }
    return parts.join(input.separator).trim();
  }
}

export type ReadRange = {
  start: number;
  end: number;
};

export type UnreadRangeResult =
  | {
    hasUnread: true;
    start: number;
    end: number;
  }
  | {
    hasUnread: false;
    start: number;
    end: number;
  };

export function findContiguousUnreadRange(input: {
  requestedStart: number;
  totalEnd: number;
  returnedRanges: readonly ReadRange[];
}): UnreadRangeResult {
  const totalEnd = Math.max(1, Math.floor(input.totalEnd));
  let start = Math.max(1, Math.floor(input.requestedStart));
  const ranges = [...input.returnedRanges]
    .map((range) => ({
      start: Math.max(1, Math.floor(range.start)),
      end: Math.max(1, Math.floor(range.end)),
    }))
    .filter((range) => range.end > range.start)
    .sort((left, right) => (left.start - right.start) || (left.end - right.end));

  for (const range of ranges) {
    if (range.end <= start) {
      continue;
    }
    if (range.start <= start && start < range.end) {
      start = range.end;
      continue;
    }
    break;
  }

  if (start >= totalEnd) {
    return { hasUnread: false, start: totalEnd, end: totalEnd };
  }

  const nextRange = ranges.find((range) => range.start > start);
  const end = Math.min(totalEnd, nextRange ? nextRange.start : totalEnd);
  if (end <= start) {
    return { hasUnread: false, start, end: start };
  }
  return { hasUnread: true, start, end };
}
