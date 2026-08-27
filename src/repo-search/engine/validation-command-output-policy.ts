import type { RunOutputMode } from '../repo-tool-arguments.js';

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

export function isValidationCommand(command: string): boolean {
  const segments = command.split(/;|&&|\|\|/u);
  return segments.some((rawSegment) => {
    const segment = rawSegment.trim();
    return segment.length > 0 && VALIDATION_COMMAND_PATTERNS.some((pattern) => pattern.test(segment));
  });
}

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
    return isValidationCommand(command);
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
   * Summary lines are reserved first, then the tail is grown downward for as long as the rendered
   * result still fits. Indices are returned ascending so the result still reads as a log. With no
   * summary lines this is exactly the previous tail-only behavior.
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
    const reserved = this.trimToLineLimit(summaryIndices.slice(-this.lineLimit));
    let tailStart = lines.length;
    while (this.renderedLineCount(this.mergeTail(reserved, tailStart - 1, lines.length)) <= this.lineLimit) {
      tailStart -= 1;
    }
    return this.mergeTail(reserved, tailStart, lines.length);
  }

  /** Reserved lines above `tailStart`, then every line from `tailStart` to the end. */
  private mergeTail(reserved: readonly number[], tailStart: number, lineCount: number): number[] {
    return [
      ...reserved.filter((index) => index < tailStart),
      ...this.tailIndices(lineCount, lineCount - tailStart),
    ];
  }

  /**
   * Retained lines plus the `… n lines omitted …` marker each interior gap renders as. Markers are
   * part of what the caller has to read, so scattered summary lines would otherwise emit close to
   * twice `lineLimit` and defeat the cap the policy exists to enforce.
   */
  private renderedLineCount(indices: readonly number[]): number {
    let count = indices.length;
    for (let index = 1; index < indices.length; index += 1) {
      if (indices[index] - indices[index - 1] > 1) {
        count += 1;
      }
    }
    return count;
  }

  /**
   * Drops the earliest indices until the marker-inclusive rendering fits, keeping the newest ones.
   * Terminates because a single index renders as one line and `lineLimit` is at least one.
   */
  private trimToLineLimit(indices: readonly number[]): number[] {
    let start = 0;
    while (this.renderedLineCount(indices.slice(start)) > this.lineLimit) {
      start += 1;
    }
    return indices.slice(start);
  }

  /**
   * `apply` returns early when `lines.length <= this.lineLimit`, and the tail can never outgrow
   * `lineLimit` without failing the fit check, so `count < lineCount` at every call site.
   */
  private tailIndices(lineCount: number, count: number): number[] {
    const indices: number[] = [];
    for (let index = lineCount - count; index < lineCount; index += 1) {
      indices.push(index);
    }
    return indices;
  }
}

export const RUN_FULL_DOWNGRADE_NOTICE =
  'Notice: outputMode "full" was served as "auto" for this validation command. '
  + 'If the raw output is genuinely required, repeat this identical run with outputMode "full" as your next run call.';

type RunFullOutputGateState =
  | { kind: 'idle' }
  | { kind: 'pending'; command: string }
  | { kind: 'consumed'; command: string };

export type RunFullOutputDecision =
  | { kind: 'pass'; effectiveMode: RunOutputMode; downgraded: false }
  | { kind: 'downgrade'; effectiveMode: 'auto'; downgraded: true }
  | { kind: 'retry'; effectiveMode: 'full'; downgraded: false }
  | { kind: 'duplicate' };

/**
 * First `full` request on a validation command is served as `auto`; only an immediate
 * back-to-back retry of the identical command with `full` is honored. Any other `run`
 * call in between forfeits the pending grant; non-run tools do not touch it.
 */
export class RunFullOutputGate {
  private state: RunFullOutputGateState = { kind: 'idle' };

  beginRun(options: {
    command: string;
    requestedMode: RunOutputMode;
    isValidationCommand: boolean;
  }): RunFullOutputDecision {
    const previous = this.state;
    this.state = { kind: 'idle' };
    if (options.requestedMode !== 'full' || !options.isValidationCommand) {
      return { kind: 'pass', effectiveMode: options.requestedMode, downgraded: false };
    }
    if (previous.kind === 'pending' && previous.command === options.command) {
      this.state = { kind: 'consumed', command: options.command };
      return { kind: 'retry', effectiveMode: 'full', downgraded: false };
    }
    if (previous.kind === 'consumed' && previous.command === options.command) {
      this.state = previous;
      return { kind: 'duplicate' };
    }
    this.state = { kind: 'pending', command: options.command };
    return { kind: 'downgrade', effectiveMode: 'auto', downgraded: true };
  }
}
