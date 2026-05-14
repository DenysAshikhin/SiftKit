export type ToolOutputTruncationUnit = 'lines' | 'files' | 'results';

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

    let low = 0;
    let high = totalCount;
    let bestCount = 0;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const candidate = this.buildCandidate(input, mid);
      const tokenCount = await this.tokenCounter.countToolOutputTokens(candidate);
      if (tokenCount <= maxTokens) {
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
    const body = input.segments.slice(0, segmentCount).join(input.separator).trim();
    if (body) {
      parts.push(body);
    }
    const truncatedCount = input.segments.length - segmentCount;
    if (truncatedCount > 0) {
      parts.push(`${truncatedCount} ${input.unit} truncated due to per-tool context limit.`);
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
