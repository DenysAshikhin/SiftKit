// Summary module barrel — re-exports from submodules.
// Preserves the dist/summary.js public surface for tests and consumers.

export type {
  SummaryPolicyProfile,
  SummarySourceKind,
  SummaryClassification,
  SummaryRequest,
  SummaryResult,
} from './summary/types.js';

export { UNSUPPORTED_INPUT_MESSAGE, getDeterministicExcerpt } from './summary/measure.js';
export { buildPrompt } from './summary/prompt.js';
export { getSummaryDecision } from './summary/decision.js';
export { planTokenAwareLlamaCppChunks, getPlannerPromptBudget } from './summary/chunking.js';
export { buildPlannerToolDefinitions } from './summary/planner/tools.js';
export { summarizeRequest, readSummaryInput } from './summary/core.js';
