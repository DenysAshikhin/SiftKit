/** Predicted-vs-server prompt token divergence above this is a counting bug, not noise. */
export const PROMPT_DRIFT_WARN_TOKENS = 1_024;

export type PromptDriftRecord = {
  predictedPromptTokens: number;
  serverPromptTokens: number;
  driftTokens: number;
  warn: boolean;
};

export function evaluatePromptDrift(options: {
  predictedPromptTokens: number;
  serverPromptTokens: number | null;
}): PromptDriftRecord | null {
  const serverPromptTokens = options.serverPromptTokens;
  if (serverPromptTokens === null || !Number.isFinite(serverPromptTokens) || serverPromptTokens <= 0) {
    return null;
  }
  const driftTokens = Math.abs(serverPromptTokens - options.predictedPromptTokens);
  return {
    predictedPromptTokens: options.predictedPromptTokens,
    serverPromptTokens,
    driftTokens,
    warn: driftTokens >= PROMPT_DRIFT_WARN_TOKENS,
  };
}
