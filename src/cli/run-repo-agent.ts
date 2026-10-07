import type { RepoAgentInvocation } from './repo-agent-args.ts';
import { RepoAgentCommand } from './repo-agent-command.ts';
import { StatusServerApiClient } from './status-server-api-client.ts';

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
