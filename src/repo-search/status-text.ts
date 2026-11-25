import { REPO_TOOL_ARGUMENT_SCHEMAS } from './repo-tool-arguments.ts';

/** A path: a drive or a backslash, or a slash inside a word that also has an extension or a second slash. "and/or" is prose. */
const PATH = /[A-Za-z]:[\\/]|\\|(?:^|\s)\.{0,2}\/\w|\w[\w.-]*\/[\w.-]+(?:\/|\.\w)/u;
const TOOL_NAMES = Object.keys(REPO_TOOL_ARGUMENT_SCHEMAS).filter((name) => name.includes('_'));

/** Why `text` cannot be shown as a status line, or null. Only what code can tell is checked; the prompt states the rest. */
export function findStatusTextProblem(text: string): string | null {
  if (/[\r\n]/u.test(text)) return 'it must be one paragraph';
  if (text.includes('`')) return 'it must not contain code or backticks';
  if (PATH.test(text)) return 'it must not contain a path';
  const tool = TOOL_NAMES.find((name) => text.includes(name));
  return tool === undefined ? null : `it must not name a tool (${tool})`;
}
