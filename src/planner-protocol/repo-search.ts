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
