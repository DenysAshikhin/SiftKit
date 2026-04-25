import { getObservedBudgetStatePath } from '../config/paths.js';
import { getRuntimeDatabase } from './runtime-db.js';

export type ObservedBudgetState = {
  observedTelemetrySeen: boolean;
  lastKnownCharsPerToken: number | null;
  observedCharsTotal: number | null;
  observedTokensTotal: number | null;
  updatedAtUtc: string | null;
};

export function getDefaultObservedBudgetState(): ObservedBudgetState {
  return {
    observedTelemetrySeen: false,
    lastKnownCharsPerToken: null,
    observedCharsTotal: null,
    observedTokensTotal: null,
    updatedAtUtc: null,
  };
}

export function normalizeObservedBudgetState(input: unknown): ObservedBudgetState {
  const fallback = getDefaultObservedBudgetState();
  if (!input || typeof input !== 'object') {
    return fallback;
  }

  const parsed = input as Record<string, unknown>;
  const observedCharsTotal = Number(parsed.observedCharsTotal);
  const observedTokensTotal = Number(parsed.observedTokensTotal);
  const lastKnownCharsPerToken = Number(parsed.lastKnownCharsPerToken);
  const hasWeightedTotals = Number.isFinite(observedCharsTotal)
    && observedCharsTotal > 0
    && Number.isFinite(observedTokensTotal)
    && observedTokensTotal > 0;
  return {
    observedTelemetrySeen: hasWeightedTotals && (
      parsed.observedTelemetrySeen === true
      || parsed.observedTelemetrySeen === 1
      || Number.isFinite(lastKnownCharsPerToken)
    ),
    lastKnownCharsPerToken: hasWeightedTotals ? (observedCharsTotal / observedTokensTotal) : null,
    observedCharsTotal: hasWeightedTotals ? observedCharsTotal : null,
    observedTokensTotal: hasWeightedTotals ? observedTokensTotal : null,
    updatedAtUtc:
      typeof parsed.updatedAtUtc === 'string' && parsed.updatedAtUtc.trim()
        ? parsed.updatedAtUtc
        : null,
  };
}

export function readObservedBudgetState(): ObservedBudgetState {
  const database = getRuntimeDatabase(getObservedBudgetStatePath());
  const row = database.prepare(`
    SELECT observed_telemetry_seen, last_known_chars_per_token, observed_chars_total, observed_tokens_total, updated_at_utc
    FROM observed_budget_state
    WHERE id = 1
  `).get() as Record<string, unknown> | undefined;
  if (!row) {
    return getDefaultObservedBudgetState();
  }
  return normalizeObservedBudgetState({
    observedTelemetrySeen: Number(row.observed_telemetry_seen) === 1,
    lastKnownCharsPerToken: Number(row.last_known_chars_per_token),
    observedCharsTotal: Number(row.observed_chars_total),
    observedTokensTotal: Number(row.observed_tokens_total),
    updatedAtUtc: typeof row.updated_at_utc === 'string' ? row.updated_at_utc : null,
  });
}

export function writeObservedBudgetState(state: ObservedBudgetState): void {
  const normalized = normalizeObservedBudgetState(state);
  const database = getRuntimeDatabase(getObservedBudgetStatePath());
  database.prepare(`
    INSERT INTO observed_budget_state (
      id,
      observed_telemetry_seen,
      last_known_chars_per_token,
      observed_chars_total,
      observed_tokens_total,
      updated_at_utc
    ) VALUES (1, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      observed_telemetry_seen = excluded.observed_telemetry_seen,
      last_known_chars_per_token = excluded.last_known_chars_per_token,
      observed_chars_total = excluded.observed_chars_total,
      observed_tokens_total = excluded.observed_tokens_total,
      updated_at_utc = excluded.updated_at_utc
  `).run(
    normalized.observedTelemetrySeen ? 1 : 0,
    normalized.lastKnownCharsPerToken,
    normalized.observedCharsTotal,
    normalized.observedTokensTotal,
    normalized.updatedAtUtc,
  );
}

export function tryWriteObservedBudgetState(state: ObservedBudgetState): void {
  try {
    writeObservedBudgetState(state);
  } catch {
    // Observed-budget persistence is advisory. Request execution should continue.
  }
}

export function recordAccurateCharTokenObservation(options: {
  chars: number;
  tokens: number;
  updatedAtUtc?: string;
}): void {
  const chars = Number(options.chars);
  const tokens = Number(options.tokens);
  if (!Number.isFinite(chars) || chars <= 0 || !Number.isFinite(tokens) || tokens <= 0) {
    return;
  }

  const previous = readObservedBudgetState();
  const observedCharsTotal = (previous.observedCharsTotal ?? 0) + chars;
  const observedTokensTotal = (previous.observedTokensTotal ?? 0) + tokens;
  writeObservedBudgetState({
    observedTelemetrySeen: true,
    lastKnownCharsPerToken: observedCharsTotal / observedTokensTotal,
    observedCharsTotal,
    observedTokensTotal,
    updatedAtUtc: options.updatedAtUtc ?? new Date().toISOString(),
  });
}

export function tryRecordAccurateCharTokenObservation(options: {
  chars: number;
  tokens: number;
  updatedAtUtc?: string;
}): void {
  try {
    recordAccurateCharTokenObservation(options);
  } catch {
    // Observed-budget persistence is advisory. Request execution should continue.
  }
}
