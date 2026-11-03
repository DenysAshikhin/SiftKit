import type { RunOutputMode } from '../repo-tool-arguments.ts';

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

  /** Keeps the last `lineLimit` lines; the run's digest, taken from the whole output first, carries its verdict and failures. */
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
    const omittedLineCount = lines.length - this.lineLimit;
    return [
      `${omittedLineCount} ${pluralizeLines(omittedLineCount)} omitted from validation command output.`,
      ...lines.slice(-this.lineLimit),
    ].join('\n');
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
