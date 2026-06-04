import { useEffect, useState } from 'react';

import type { ChatSession, DashboardPreset } from '../types';

export function selectInitialPlanRepoRoot(session: ChatSession | null): string {
  return session?.planRepoRoot || '';
}

export function selectPresetMaxTurnsText(preset: DashboardPreset | null, fallback: string): string {
  if (!preset) {
    return fallback;
  }
  if (preset.maxTurns === null) {
    return fallback;
  }
  return String(preset.maxTurns);
}

export type UsePlanInputsResult = {
  planRepoRootInput: string;
  planMaxTurnsInput: string;
  setPlanRepoRootInput(value: string): void;
};

const DEFAULT_MAX_TURNS = '45';

export function usePlanInputs(deps: {
  selectedSession: ChatSession | null;
  selectedChatPreset: DashboardPreset | null;
}): UsePlanInputsResult {
  const [planRepoRootInput, setPlanRepoRootInput] = useState<string>(selectInitialPlanRepoRoot(deps.selectedSession));
  const [planMaxTurnsInput, setPlanMaxTurnsInput] = useState<string>(
    selectPresetMaxTurnsText(deps.selectedChatPreset, DEFAULT_MAX_TURNS),
  );

  useEffect(() => {
    setPlanRepoRootInput(selectInitialPlanRepoRoot(deps.selectedSession));
  }, [deps.selectedSession?.id, deps.selectedSession?.planRepoRoot]);

  useEffect(() => {
    if (!deps.selectedChatPreset) {
      return;
    }
    if (deps.selectedChatPreset.maxTurns !== null) {
      setPlanMaxTurnsInput(String(deps.selectedChatPreset.maxTurns));
    }
  }, [deps.selectedChatPreset?.id]);

  return {
    planRepoRootInput,
    planMaxTurnsInput,
    setPlanRepoRootInput,
  };
}
