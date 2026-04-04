import {
  readObservedBudgetState,
  tryWriteObservedBudgetState,
} from '../state/observed-budget.js';
import { SIFT_INPUT_CHARACTERS_PER_CONTEXT_TOKEN } from './constants.js';
import { MissingObservedBudgetError } from './errors.js';
import {
  getConfiguredLlamaNumCtx,
  getDefaultNumCtx,
  getMissingRuntimeFields,
} from './getters.js';
import { getStatusSnapshot } from './status-backend.js';
import type { NormalizationInfo, SiftConfig, StatusSnapshotResponse } from './types.js';

export function getDerivedMaxInputCharacters(
  numCtx: number,
  inputCharactersPerContextToken: number = SIFT_INPUT_CHARACTERS_PER_CONTEXT_TOKEN
): number {
  const effectiveNumCtx = numCtx > 0 ? numCtx : getDefaultNumCtx();
  const effectiveCharactersPerContextToken = inputCharactersPerContextToken > 0
    ? inputCharactersPerContextToken
    : SIFT_INPUT_CHARACTERS_PER_CONTEXT_TOKEN;
  return Math.max(Math.floor(effectiveNumCtx * effectiveCharactersPerContextToken), 1);
}

export function getEffectiveInputCharactersPerContextToken(config: SiftConfig): number {
  const effectiveValue = Number(config.Effective?.InputCharactersPerContextToken);
  return effectiveValue > 0 ? effectiveValue : SIFT_INPUT_CHARACTERS_PER_CONTEXT_TOKEN;
}

export function getEffectiveMaxInputCharacters(config: SiftConfig): number {
  return getDerivedMaxInputCharacters(
    getConfiguredLlamaNumCtx(config),
    getEffectiveInputCharactersPerContextToken(config)
  );
}

export function getChunkThresholdCharacters(config: SiftConfig): number {
  return Math.max(getEffectiveMaxInputCharacters(config), 1);
}

function getObservedInputCharactersPerContextToken(
  snapshot: StatusSnapshotResponse | null | undefined
): number | null {
  const inputCharactersTotal = Number(snapshot?.metrics?.inputCharactersTotal);
  const inputTokensTotal = Number(snapshot?.metrics?.inputTokensTotal);
  if (!Number.isFinite(inputCharactersTotal) || inputCharactersTotal <= 0) {
    return null;
  }
  if (!Number.isFinite(inputTokensTotal) || inputTokensTotal <= 0) {
    return null;
  }

  return inputCharactersTotal / inputTokensTotal;
}

export async function resolveInputCharactersPerContextToken(): Promise<{ value: number; budgetSource: string }> {
  const persistedState = readObservedBudgetState();
  let snapshot: StatusSnapshotResponse;
  try {
    snapshot = await getStatusSnapshot();
  } catch {
    if (persistedState.observedTelemetrySeen) {
      throw new MissingObservedBudgetError(
        'SiftKit previously recorded a valid observed chars-per-token budget, but the status server is unavailable or no longer exposes usable totals. Refusing to fall back to the hardcoded bootstrap estimate after telemetry has been established.'
      );
    }
    return {
      value: SIFT_INPUT_CHARACTERS_PER_CONTEXT_TOKEN,
      budgetSource: 'ColdStartFixedCharsPerToken',
    };
  }

  const observedValue = getObservedInputCharactersPerContextToken(snapshot);
  if (observedValue !== null) {
    tryWriteObservedBudgetState({
      observedTelemetrySeen: true,
      lastKnownCharsPerToken: observedValue,
      updatedAtUtc: new Date().toISOString(),
    });
    return {
      value: observedValue,
      budgetSource: 'ObservedCharsPerToken',
    };
  }

  if (persistedState.observedTelemetrySeen) {
    throw new MissingObservedBudgetError(
      'SiftKit previously recorded a valid observed chars-per-token budget, but the status server no longer provides usable input character/token totals. Refusing to fall back to the hardcoded bootstrap estimate after telemetry has been established.'
    );
  }

  return {
    value: SIFT_INPUT_CHARACTERS_PER_CONTEXT_TOKEN,
    budgetSource: 'ColdStartFixedCharsPerToken',
  };
}

export async function addEffectiveConfigProperties(
  config: SiftConfig,
  info: NormalizationInfo
): Promise<SiftConfig> {
  const effectiveBudget = await resolveInputCharactersPerContextToken();
  const missingRuntimeFields = getMissingRuntimeFields(config);
  const runtimeConfigReady = missingRuntimeFields.length === 0;
  const numCtx = runtimeConfigReady ? getConfiguredLlamaNumCtx(config) : null;
  const maxInputCharacters = numCtx === null
    ? null
    : getDerivedMaxInputCharacters(numCtx, effectiveBudget.value);
  return {
    ...config,
    Effective: {
      ConfigAuthoritative: true,
      RuntimeConfigReady: runtimeConfigReady,
      MissingRuntimeFields: missingRuntimeFields,
      BudgetSource: effectiveBudget.budgetSource,
      NumCtx: numCtx,
      InputCharactersPerContextToken: effectiveBudget.value,
      ObservedTelemetrySeen: effectiveBudget.budgetSource !== 'ColdStartFixedCharsPerToken',
      ObservedTelemetryUpdatedAtUtc: readObservedBudgetState().updatedAtUtc,
      MaxInputCharacters: maxInputCharacters,
      ChunkThresholdCharacters: maxInputCharacters,
      LegacyMaxInputCharactersRemoved: info.legacyMaxInputCharactersRemoved,
      LegacyMaxInputCharactersValue: info.legacyMaxInputCharactersValue,
    },
  };
}
