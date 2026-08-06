import { runCapturedCommand, type CapturedCommandResult } from './captured-command.js';

export type DirectCommandResult = CapturedCommandResult;

export type DirectCommandOptions = {
  cwd?: string;
  windowsHide?: boolean;
  abortSignal?: AbortSignal;
  timeoutMs?: number;
  /**
   * When provided, this is the child's ENTIRE environment — nothing is inherited implicitly.
   * Full replacement (not merge) because scrubbing dangerous inherited variables (GIT_DIR,
   * GIT_EXTERNAL_DIFF, ...) requires removal, which a merge cannot express.
   */
  env?: Record<string, string>;
};

export function spawnDirectCommand(
  command: string,
  args: string[],
  options: DirectCommandOptions = {},
): Promise<DirectCommandResult> {
  return runCapturedCommand(command, args, options);
}
