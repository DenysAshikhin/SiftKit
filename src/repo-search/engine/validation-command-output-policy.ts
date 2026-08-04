import { z } from '../../lib/zod.js';

export const REPO_AGENT_VALIDATION_OUTPUT_LINE_LIMIT = 50;

export const RunOutputModeSchema = z.enum(['auto', 'full']);
export type RunOutputMode = z.infer<typeof RunOutputModeSchema>;

const VALIDATION_COMMAND_PATTERNS = [
  /^(?:&\s*)?(?:npm(?:\.cmd)?|pnpm(?:\.cmd)?|yarn(?:\.cmd)?|bun(?:\.exe)?)\s+(?:run\s+)?(?:test|build|lint|typecheck)(?::[a-z0-9_.-]+)?(?:\s|$)/iu,
  /^(?:&\s*)?node(?:\.exe)?\s+(?=[^;|]*--test(?:[=\s]|$))/iu,
  /^(?:&\s*)?(?:jest|vitest|mocha|ava|eslint|tsc)(?:\.cmd)?(?:\s|$)/iu,
  /^(?:&\s*)?(?:(?:npx|bunx)(?:\.cmd)?|pnpm(?:\.cmd)?\s+exec|yarn(?:\.cmd)?\s+exec)\s+(?:jest|vitest|mocha|ava|eslint|tsc|playwright|cypress)(?:\.cmd)?(?:\s|$)/iu,
  /^(?:&\s*)?(?:playwright(?:\.cmd)?\s+test|cypress(?:\.cmd)?\s+run)(?:\s|$)/iu,
  /^(?:&\s*)?(?:python(?:3)?(?:\.exe)?\s+-m\s+pytest|pytest(?:\.exe)?|ruff(?:\.exe)?(?:\s+check)?|mypy(?:\.exe)?|pyright(?:\.cmd)?)(?:\s|$)/iu,
  /^(?:&\s*)?dotnet(?:\.exe)?\s+(?:build|test)(?:\s|$)/iu,
  /^(?:&\s*)?cargo(?:\.exe)?\s+(?:build|test|check|clippy)(?:\s|$)/iu,
  /^(?:&\s*)?go(?:\.exe)?\s+(?:build|test|vet)(?:\s|$)/iu,
  /^(?:&\s*)?(?:\.?[\\/])?(?:gradle|gradlew)(?:\.bat)?\b.*\s(?::[a-z0-9_.-]+:)?(?:build|test|check)[a-z0-9_.-]*(?:\s|$)/iu,
  /^(?:&\s*)?(?:\.?[\\/])?(?:mvn|mvnw)(?:\.cmd)?\b.*\s(?:compile|package|test|verify|check)(?:\s|$)/iu,
  /^(?:&\s*)?cmake(?:\.exe)?\s+--build(?:\s|$)/iu,
  /^(?:&\s*)?ctest(?:\.exe)?(?:\s|$)/iu,
] as const;

/**
 * Node's spec reporter prints its counts before an unbounded `✖ failing tests:` block, so pure-tail
 * retention drops the verdict exactly when there are enough failures for it to matter. These lines are
 * retained regardless of position; output from any other reporter matches nothing here and degrades to
 * plain tail.
 */
const SUMMARY_LINE_PATTERNS = [
  /^\s*ℹ /u,
  /^\s*✖ failing tests:/u,
] as const;

function pluralizeLines(count: number): string {
  return count === 1 ? 'line' : 'lines';
}

export class ValidationCommandOutputPolicy {
  private readonly lineLimit: number;

  constructor(lineLimit: number) {
    this.lineLimit = Math.max(1, Math.trunc(lineLimit));
  }

  isValidationCommand(command: string): boolean {
    const segments = command.split(/;|&&|\|\|/u);
    for (const rawSegment of segments) {
      const segment = rawSegment.trim();
      if (!segment) {
        continue;
      }
      for (const pattern of VALIDATION_COMMAND_PATTERNS) {
        if (pattern.test(segment)) {
          return true;
        }
      }
    }
    return false;
  }

  apply(options: {
    command: string;
    output: string;
    outputMode: RunOutputMode;
  }): string {
    if (options.outputMode === 'full' || !this.isValidationCommand(options.command)) {
      return options.output;
    }
    const lines = options.output.split(/\r\n|\r|\n/u);
    if (lines[lines.length - 1] === '') {
      lines.pop();
    }
    if (lines.length <= this.lineLimit) {
      return options.output;
    }
    const retainedIndices = this.selectRetainedIndices(lines);
    const omittedLineCount = lines.length - retainedIndices.length;
    const rendered = [
      `${omittedLineCount} ${pluralizeLines(omittedLineCount)} omitted from validation command output.`,
    ];
    let previousIndex: number | null = null;
    for (const index of retainedIndices) {
      if (previousIndex !== null) {
        const gap = index - previousIndex - 1;
        if (gap > 0) {
          rendered.push(`… ${gap} ${pluralizeLines(gap)} omitted …`);
        }
      }
      rendered.push(lines[index]);
      previousIndex = index;
    }
    return rendered.join('\n');
  }

  /**
   * Summary lines are reserved first, then the remaining budget is filled from the tail. Indices are
   * returned ascending so the result still reads as a log. With no summary lines this is exactly the
   * previous tail-only behavior.
   */
  private selectRetainedIndices(lines: readonly string[]): number[] {
    const summaryIndices: number[] = [];
    for (const [index, line] of lines.entries()) {
      if (SUMMARY_LINE_PATTERNS.some((pattern) => pattern.test(line))) {
        summaryIndices.push(index);
      }
    }
    if (summaryIndices.length === 0) {
      return this.tailIndices(lines.length, this.lineLimit);
    }
    const reserved = summaryIndices.slice(-this.lineLimit);
    const retained = new Set([...reserved, ...this.tailIndices(lines.length, this.lineLimit - reserved.length)]);
    return [...retained].sort((left, right) => left - right);
  }

  private tailIndices(lineCount: number, count: number): number[] {
    const indices: number[] = [];
    for (let index = Math.max(0, lineCount - count); index < lineCount; index += 1) {
      indices.push(index);
    }
    return indices;
  }
}
