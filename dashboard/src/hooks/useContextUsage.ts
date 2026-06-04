import { useState } from 'react';

import type { ContextUsage } from '../types';

export type UseContextUsageResult = {
  contextUsage: ContextUsage | null;
  setContextUsage(value: ContextUsage | null): void;
  liveToolPromptTokenCount: number | null;
  setLiveToolPromptTokenCount(value: number | null): void;
};

export function useContextUsage(): UseContextUsageResult {
  const [contextUsage, setContextUsage] = useState<ContextUsage | null>(null);
  const [liveToolPromptTokenCount, setLiveToolPromptTokenCount] = useState<number | null>(null);
  return {
    contextUsage,
    setContextUsage,
    liveToolPromptTokenCount,
    setLiveToolPromptTokenCount,
  };
}
