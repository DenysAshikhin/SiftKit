// Repo-search module public API barrel.

export {
  executeRepoSearchRequest,
} from './execute.ts';
export {
  assertConfiguredModelPresent,
  buildScorecard,
  runRepoSearch,
  runTaskLoop,
  type Scorecard,
  type TaskDefinition,
  type TaskResult,
} from './engine.ts';
export {
  buildIgnorePolicy,
  type IgnorePolicy,
} from './command-safety.ts';
export type { ChatMessage } from './planner-chat-message.ts';
export { estimateTokenCount } from '../lib/token-estimate.ts';
export {
  countTokensWithFallback,
  preflightPlannerPromptBudget,
} from './prompt-budget.ts';
export type {
  JsonLogger,
  RepoSearchExecutionRequest,
  RepoSearchExecutionResult,
  RepoSearchMockCommandResult,
  RepoSearchProgressEvent,
} from './types.ts';
