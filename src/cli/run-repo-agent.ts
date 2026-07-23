import { runRepoTaskCli } from './run-repo-search.js';

export async function runRepoAgentCli(options: {
  argv: string[];
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  stdin?: NodeJS.ReadableStream & { isTTY?: boolean };
}): Promise<number> {
  return runRepoTaskCli({ mode: 'agent', ...options });
}
