import type { RepoAgentInvocation } from './repo-agent-args.js';
import { RepoAgentCommand } from './repo-agent-command.js';
import { StatusServerApiClient } from './status-server-api-client.js';

export async function runRepoAgentCli(options: {
  invocation: RepoAgentInvocation;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  stdin?: NodeJS.ReadableStream & { isTTY?: boolean };
}): Promise<number> {
  const command = new RepoAgentCommand({
    api: new StatusServerApiClient(),
  });
  return command.run(options.invocation, options);
}
