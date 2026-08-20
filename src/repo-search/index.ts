// Repo-search module public API barrel.

export {
  executeRepoSearchRequest,
} from './execute.js';
export {
  assertConfiguredModelPresent,
  buildScorecard,
  runRepoSearch,
  runTaskLoop,
  type Scorecard,
  type TaskDefinition,
  type TaskResult,
} from './engine.js';
export {
  evaluateCommandSafety,
  buildIgnorePolicy,
  type IgnorePolicy,
  type SafetyResult,
} from './command-safety.js';
export {
  type PlannerAction,
  type ToolAction,
  type FinishAction,
  type ChatMessage,
} from './planner-protocol.js';
export { estimateTokenCount } from '../lib/token-estimate.js';
export {
  countTokensWithFallback,
  preflightPlannerPromptBudget,
} from './prompt-budget.js';
export type {
  JsonLogger,
  RepoSearchExecutionRequest,
  RepoSearchExecutionResult,
  RepoSearchMockCommandResult,
  RepoSearchProgressEvent,
} from './types.js';
