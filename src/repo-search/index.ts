// Repo-search module public API barrel.

export {
  DEFAULT_REPO_SEARCH_PROMPT_TIMEOUT_MS,
  executeRepoSearchRequest,
} from './execute.js';
export {
  assertConfiguredModelPresent,
  buildScorecard,
  runRepoSearch,
  runTaskLoop,
  TASK_PACK,
  type Scorecard,
  type TaskDefinition,
  type TaskResult,
} from './engine.js';
export {
  evaluateCommandSafety,
  normalizePlannerCommand,
  buildIgnorePolicy,
  type IgnorePolicy,
  type NormalizedCommand,
  type SafetyResult,
} from './command-safety.js';
export {
  parsePlannerAction,
  type PlannerAction,
  type ToolAction,
  type FinishAction,
  type ChatMessage,
} from './planner-protocol.js';
export {
  estimateTokenCount,
  countTokensWithFallback,
  preflightPlannerPromptBudget,
  compactPlannerMessagesOnce,
} from './prompt-budget.js';
export type {
  JsonLogger,
  RepoSearchExecutionRequest,
  RepoSearchExecutionResult,
  RepoSearchMockCommandResult,
  RepoSearchProgressEvent,
} from './types.js';
