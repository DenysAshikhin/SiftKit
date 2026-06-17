import { sleep } from '../../lib/time.js';
import type { TemporaryTimingRecorder } from '../../lib/temporary-timing-recorder.js';
import { appendTestProviderEvent } from '../artifacts.js';
import { buildMockDecision, toMockDecision } from '../mock.js';
import type { ProviderSummaryMetrics } from '../provider-invoke.js';
import type { SummaryPhase } from '../types.js';

// Sole owner of the SIFTKIT_TEST_PROVIDER_* env seam: only the `mock` backend reads it.
function getMockSummary(prompt: string, question: string, phase: SummaryPhase): string {
  const behavior = process.env.SIFTKIT_TEST_PROVIDER_BEHAVIOR?.trim() || '';
  if (behavior === 'throw') {
    throw new Error('mock provider failure');
  }
  if (behavior === 'recursive-merge') {
    return toMockDecision({
      classification: 'summary',
      rawReviewRequired: false,
      output: 'merge summary',
    });
  }

  const token = process.env.SIFTKIT_TEST_TOKEN;
  const decision = buildMockDecision(prompt, question, phase);
  if (token && decision.output === 'mock summary') {
    decision.output = `mock summary ${token}`;
  }
  return toMockDecision(decision);
}

export async function runMockProvider(options: {
  backend: string;
  model: string;
  prompt: string;
  question: string;
  phase: SummaryPhase;
  promptCharacterCount: number;
  promptTokenCount: number | null;
  rawInputCharacterCount: number;
  chunkInputCharacterCount: number;
  statusRunningMs: number;
  startedAt: number;
  chunkLabel: string;
  timingRecorder?: TemporaryTimingRecorder | null;
}): Promise<{ text: string; metrics: ProviderSummaryMetrics }> {
  const mockSpan = options.timingRecorder?.start('summary.provider.mock', {
    phase: options.phase,
    chunk: options.chunkLabel,
  });
  const rawSleep = process.env.SIFTKIT_TEST_PROVIDER_SLEEP_MS;
  const sleepMs = rawSleep ? Number.parseInt(rawSleep, 10) : 0;
  if (Number.isFinite(sleepMs) && sleepMs > 0) {
    await sleep(sleepMs);
  }
  appendTestProviderEvent({
    backend: options.backend,
    model: options.model,
    phase: options.phase,
    question: options.question,
    rawInputCharacterCount: options.rawInputCharacterCount,
    chunkInputCharacterCount: options.chunkInputCharacterCount,
  });
  const mockSummary = getMockSummary(options.prompt, options.question, options.phase);
  mockSpan?.end({ outputChars: mockSummary.length });
  const providerDurationMs = Date.now() - options.startedAt;
  return {
    text: mockSummary,
    metrics: {
      promptCharacterCount: options.promptCharacterCount,
      promptTokenCount: options.promptTokenCount,
      rawInputCharacterCount: options.rawInputCharacterCount,
      chunkInputCharacterCount: options.chunkInputCharacterCount,
      inputTokens: null,
      outputCharacterCount: mockSummary.length,
      outputTokens: null,
      thinkingTokens: null,
      promptCacheTokens: null,
      promptEvalTokens: null,
      requestDurationMs: providerDurationMs,
      providerDurationMs,
      statusRunningMs: options.statusRunningMs,
    },
  };
}
