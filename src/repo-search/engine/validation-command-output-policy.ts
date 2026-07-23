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
    const omittedLineCount = lines.length - this.lineLimit;
    const noun = omittedLineCount === 1 ? 'line' : 'lines';
    return [
      `${omittedLineCount} ${noun} omitted from validation command output.`,
      ...lines.slice(-this.lineLimit),
    ].join('\n');
  }
}
