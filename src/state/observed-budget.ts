import * as fs from 'node:fs';
import { saveContentAtomically } from '../lib/fs.js';
import { parseJsonText } from '../lib/json.js';
import { getObservedBudgetStatePath } from '../config/paths.js';

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
  const statePath = getObservedBudgetStatePath();
  if (!fs.existsSync(statePath)) {
    return getDefaultObservedBudgetState();
  }

  try {
    return normalizeObservedBudgetState(
      parseJsonText<ObservedBudgetState>(fs.readFileSync(statePath, 'utf8'))
    );
  } catch {
    return getDefaultObservedBudgetState();
  }
}

export function writeObservedBudgetState(state: ObservedBudgetState): void {
  saveContentAtomically(
    getObservedBudgetStatePath(),
    `${JSON.stringify(normalizeObservedBudgetState(state), null, 2)}\n`
  );
}

export function tryWriteObservedBudgetState(state: ObservedBudgetState): void {
  try {
    writeObservedBudgetState(state);
  } catch {
    // Observed-budget persistence is advisory. Request execution should continue.
  }
}
