import type { RunRecord } from '@siftkit/contracts';

// Tests that exercise run-selection and telemetry only set the handful of
// RunRecord fields they assert on. mockRunRecord supplies the remaining
// schema fields with null/empty defaults so callers stay cast-free.
const BASE_RUN_RECORD: RunRecord = {
  id: '',
  kind: '',
  status: '',
  startedAtUtc: null,
  finishedAtUtc: null,
  title: '',
  model: null,
  backend: null,
  inputTokens: null,
  outputTokens: null,
  thinkingTokens: null,
  toolTokens: null,
  promptCacheTokens: null,
  promptEvalTokens: null,
  promptEvalDurationMs: null,
  generationDurationMs: null,
  speculativeAcceptedTokens: null,
  speculativeGeneratedTokens: null,
  durationMs: null,
  providerDurationMs: null,
  wallDurationMs: null,
  rawPaths: {},
};

export function mockRunRecord(overrides: Partial<RunRecord>): RunRecord {
  return { ...BASE_RUN_RECORD, ...overrides };
}
