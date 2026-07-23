import { runRepoTaskCli } from './run-repo-search.js';
import type { ResolvedCliArgs } from './args.js';

export async function runRepoAgentCli(options: ResolvedCliArgs & {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  stdin?: NodeJS.ReadableStream & { isTTY?: boolean };
}): Promise<number> {
  return runRepoTaskCli({ mode: 'agent', ...options });
}
