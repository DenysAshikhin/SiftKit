/** Tools offered to non-interactive repository search. */
export const EXPOSED_REPO_TOOL_NAMES = [
  'read',
  'grep',
  'find',
  'ls',
  'git',
  'web_search',
  'web_fetch',
] as const;

/** Full repository tool surface for human-approved runs. */
export const INTERACTIVE_REPO_TOOL_NAMES = [
  ...EXPOSED_REPO_TOOL_NAMES,
  'write',
  'edit',
  'run',
] as const;

/** Tools only a web chat can serve: they need a person looking at the conversation. */
export const WEB_CHAT_TOOL_NAMES = [
  'ask_user',
  'show_image',
] as const;

/** Offered beside `run` to a run that owns background jobs. */
export const BACKGROUND_JOB_TOOL_NAME = 'job' as const;

/** Tools that ride on top of any surface, so they never turn a full one into a restricted one. */
export const RIDING_TOOL_NAMES = [...WEB_CHAT_TOOL_NAMES, BACKGROUND_JOB_TOOL_NAME] as const;

/** Tools only an orchestrator parent is offered: the host executes them against its run. */
export const ORCHESTRATOR_TOOL_NAMES = [
  'save_plan',
  'update_tasks',
  'change_approach',
  'dispatch',
  'decide',
  'run_check',
  'record_review',
] as const;
export type OrchestratorToolName = (typeof ORCHESTRATOR_TOOL_NAMES)[number];
