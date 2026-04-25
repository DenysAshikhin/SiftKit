import {
  readObservedBudgetState,
} from '../state/observed-budget.js';
import { SIFT_INPUT_CHARACTERS_PER_CONTEXT_TOKEN } from './constants.js';
import {
  getConfiguredLlamaNumCtx,
  getDefaultNumCtx,
  getMissingRuntimeFields,
} from './getters.js';
import type { NormalizationInfo, SiftConfig } from './types.js';

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

export async function resolveInputCharactersPerContextToken(): Promise<{ value: number; budgetSource: string }> {
  const persistedState = readObservedBudgetState();
  if (
    persistedState.observedTelemetrySeen
    && Number.isFinite(persistedState.observedCharsTotal)
    && Number(persistedState.observedCharsTotal) > 0
    && Number.isFinite(persistedState.observedTokensTotal)
    && Number(persistedState.observedTokensTotal) > 0
  ) {
    return {
      value: Number(persistedState.observedCharsTotal) / Number(persistedState.observedTokensTotal),
      budgetSource: 'ObservedCharsPerToken',
    };
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
