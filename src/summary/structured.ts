import {
  UNSUPPORTED_INPUT_MESSAGE,
  getDeterministicExcerpt,
  getErrorSignalMetrics,
  isPassFailQuestion,
} from './measure.js';
import type {
  ChunkPromptContext,
  StructuredModelDecision,
  SummaryPhase,
  SummarySourceKind,
} from './types.js';

export function ensureRawReviewSentence(
  decision: StructuredModelDecision,
  format: 'text' | 'json'
): StructuredModelDecision {
  if (!decision.rawReviewRequired || decision.classification === 'unsupported_input' || format === 'json') {
    return decision;
  }

  if (/\bRaw review required\./u.test(decision.output)) {
    return decision;
  }

  return {
    ...decision,
    output: `${decision.output.trim()}\nRaw review required.`,
  };
}

export function normalizeStructuredDecision(
  decision: StructuredModelDecision,
  format: 'text' | 'json'
): StructuredModelDecision {
  if (decision.classification === 'unsupported_input') {
    return {
      classification: 'unsupported_input',
      rawReviewRequired: false,
      output: UNSUPPORTED_INPUT_MESSAGE,
    };
  }

  return ensureRawReviewSentence(decision, format);
}

export function buildConservativeChunkFallbackDecision(options: {
  inputText: string;
  question: string;
  format: 'text' | 'json';
}): StructuredModelDecision {
  const excerpt = getDeterministicExcerpt(options.inputText, options.question);
  const baseSummary = 'This internally generated chunk is a partial slice of a larger supported input. The slice may be truncated or malformed, so this summary is conservative and limited to visible evidence.';
  if (options.format === 'json') {
    return {
      classification: 'summary',
      rawReviewRequired: true,
      output: JSON.stringify({
        summary: baseSummary,
        visible_anchors: excerpt ? excerpt.split('\n').slice(0, 12) : [],
      }),
    };
  }

  return {
    classification: 'summary',
    rawReviewRequired: true,
    output: excerpt
      ? `${baseSummary}\nVisible anchors:\n${excerpt}`
      : baseSummary,
  };
}

export function buildConservativeDirectFallbackDecision(options: {
  inputText: string;
  question: string;
  format: 'text' | 'json';
  sourceKind: SummarySourceKind;
}): StructuredModelDecision {
  const excerpt = getDeterministicExcerpt(options.inputText, options.question)
    || options.inputText.trim().split(/\r?\n/u).slice(0, 3).join('\n');
  const errorMetrics = getErrorSignalMetrics(options.inputText);

  if (options.format === 'json') {
    return {
      classification: 'summary',
      rawReviewRequired: false,
      output: JSON.stringify({
        summary: 'Conservative local fallback: the input was non-empty and readable.',
        visible_anchors: excerpt ? excerpt.split('\n').slice(0, 12) : [],
      }),
    };
  }

  if (options.sourceKind === 'command-output' && isPassFailQuestion(options.question)) {
    const status = errorMetrics.ErrorLineCount > 0 ? 'FAIL' : 'PASS';
    const detail = errorMetrics.ErrorLineCount > 0
      ? 'command output contains error signals'
      : 'command produced readable output with no obvious error signals';
    return {
      classification: 'summary',
      rawReviewRequired: false,
      output: excerpt ? `${status}: ${detail}. Observed output: ${excerpt}` : `${status}: ${detail}.`,
    };
  }

  return {
    classification: 'summary',
    rawReviewRequired: false,
    output: excerpt
      ? `Conservative local fallback: the input was non-empty and readable. Visible text: ${excerpt}`
      : 'Conservative local fallback: the input was non-empty and readable.',
  };
}

export function isInternalChunkLeaf(options: {
  phase?: SummaryPhase;
  chunkContext?: ChunkPromptContext;
}): boolean {
  return options.phase === 'leaf' && options.chunkContext?.isGeneratedChunk === true;
}
