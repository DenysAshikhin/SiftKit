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
  buildIgnorePolicy,
  type IgnorePolicy,
} from './command-safety.js';
export {
  type ChatMessage,
} from './planner-protocol.js';
export type {
  RepoSearchPlannerAction,
  RepoSearchToolAction,
  RepoSearchFinishAction,
} from '../planner-protocol/repo-search.js';
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
