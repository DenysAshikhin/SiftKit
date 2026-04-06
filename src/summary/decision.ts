import type { SiftConfig } from '../config/index.js';
import {
  getErrorSignalMetrics,
  measureText,
} from './measure.js';
import type {
  SummaryClassification,
  SummaryDecision,
  SummaryResult,
  SummarySourceKind,
} from './types.js';

function getCommandOutputRawReviewRequired(options: {
  text: string;
  riskLevel: 'informational' | 'debug' | 'risky';
  commandExitCode?: number | null;
  errorMetrics: ReturnType<typeof getErrorSignalMetrics>;
}): boolean {
  if (options.riskLevel !== 'informational') {
    return true;
  }

  if (Number.isFinite(options.commandExitCode) && Number(options.commandExitCode) !== 0) {
    return true;
  }

  if (/\b(fatal|panic|traceback|segmentation fault|core dumped|assert(?:ion)? failed|uncaught exception|out of memory)\b/iu.test(options.text)) {
    return true;
  }

  return (
    options.errorMetrics.ErrorLineCount >= 3
    || (
      options.errorMetrics.NonEmptyLineCount >= 6
      && options.errorMetrics.ErrorRatio >= 0.5
    )
  );
}

export function getSummaryDecision(
  text: string,
  question: string | null | undefined,
  riskLevel: 'informational' | 'debug' | 'risky',
  config: SiftConfig,
  options?: {
    sourceKind?: SummarySourceKind;
    commandExitCode?: number | null;
  },
): SummaryDecision {
  const metrics = measureText(text);
  const errorMetrics = getErrorSignalMetrics(text);
  const hasMaterialErrorSignals = (
    errorMetrics.ErrorLineCount > 0
    && (
      errorMetrics.NonEmptyLineCount <= 20
      || (errorMetrics.ErrorLineCount >= 5 && errorMetrics.ErrorRatio >= 0.25)
      || errorMetrics.ErrorRatio >= 0.25
    )
  );
  const isShort = (
    metrics.CharacterCount < Number(config.Thresholds.MinCharactersForSummary)
    && metrics.LineCount < Number(config.Thresholds.MinLinesForSummary)
  );
  const sourceKind = options?.sourceKind || 'standalone';
  const rawReviewRequired = sourceKind === 'command-output'
    ? getCommandOutputRawReviewRequired({
      text,
      riskLevel,
      commandExitCode: options?.commandExitCode,
      errorMetrics,
    })
    : (riskLevel !== 'informational' || hasMaterialErrorSignals);
  const reason = isShort
    ? 'model-first-short'
    : (rawReviewRequired ? 'model-first-risk-review' : 'model-first');

  return {
    ShouldSummarize: true,
    Reason: question ? reason : 'model-first',
    RawReviewRequired: rawReviewRequired,
    CharacterCount: metrics.CharacterCount,
    LineCount: metrics.LineCount,
  };
}

export function getPolicyDecision(classification: SummaryClassification): SummaryResult['PolicyDecision'] {
  if (classification === 'command_failure') {
    return 'model-command-failure';
  }
  if (classification === 'unsupported_input') {
    return 'model-unsupported-input';
  }
  return 'model-summary';
}
