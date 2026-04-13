import { getObservedBudgetStatePath } from '../config/paths.js';
import { getRuntimeDatabase } from './runtime-db.js';

export type ObservedBudgetState = {
  observedTelemetrySeen: boolean;
  lastKnownCharsPerToken: number | null;
  updatedAtUtc: string | null;
};

export function getDefaultObservedBudgetState(): ObservedBudgetState {
  return {
    observedTelemetrySeen: false,
    lastKnownCharsPerToken: null,
    updatedAtUtc: null,
  };
}

export function normalizeObservedBudgetState(input: unknown): ObservedBudgetState {
  const fallback = getDefaultObservedBudgetState();
  if (!input || typeof input !== 'object') {
    return fallback;
  }

  const parsed = input as Record<string, unknown>;
  const lastKnownCharsPerToken = Number(parsed.lastKnownCharsPerToken);
  return {
    observedTelemetrySeen:
      parsed.observedTelemetrySeen === true
      && Number.isFinite(lastKnownCharsPerToken)
      && lastKnownCharsPerToken > 0,
    lastKnownCharsPerToken:
      Number.isFinite(lastKnownCharsPerToken) && lastKnownCharsPerToken > 0
        ? lastKnownCharsPerToken
        : null,
    updatedAtUtc:
      typeof parsed.updatedAtUtc === 'string' && parsed.updatedAtUtc.trim()
        ? parsed.updatedAtUtc
        : null,
  };
}

export function readObservedBudgetState(): ObservedBudgetState {
  const database = getRuntimeDatabase(getObservedBudgetStatePath());
  const row = database.prepare(`
    SELECT observed_telemetry_seen, last_known_chars_per_token, updated_at_utc
    FROM observed_budget_state
    WHERE id = 1
  `).get() as Record<string, unknown> | undefined;
  if (!row) {
    return getDefaultObservedBudgetState();
  }
  return normalizeObservedBudgetState({
    observedTelemetrySeen: Number(row.observed_telemetry_seen) === 1,
    lastKnownCharsPerToken: Number(row.last_known_chars_per_token),
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
      updated_at_utc
    ) VALUES (1, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      observed_telemetry_seen = excluded.observed_telemetry_seen,
      last_known_chars_per_token = excluded.last_known_chars_per_token,
      updated_at_utc = excluded.updated_at_utc
  `).run(
    normalized.observedTelemetrySeen ? 1 : 0,
    normalized.lastKnownCharsPerToken,
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
