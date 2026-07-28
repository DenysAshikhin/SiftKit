import { join } from 'node:path';

import { getRuntimeRoot } from '../config/index.js';
import { RepoAgentRunStore } from '../repo-agent/run-store.js';
import {
  getRepoAgentWorkerEntrypoint,
  RepoAgentWorkerLauncher,
} from '../repo-agent/worker-launcher.js';
import type { RepoAgentInvocation } from './repo-agent-args.js';
import { RepoAgentCommand } from './repo-agent-command.js';

export async function runRepoAgentCli(options: {
  invocation: RepoAgentInvocation;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  stdin?: NodeJS.ReadableStream & { isTTY?: boolean };
}): Promise<number> {
  const store = new RepoAgentRunStore(
    join(getRuntimeRoot(), 'repo-agent', 'runs'),
  );
  const launcher = new RepoAgentWorkerLauncher({
    nodeExecutable: process.execPath,
    workerEntrypoint: getRepoAgentWorkerEntrypoint(),
    store,
  });
  const command = new RepoAgentCommand({
    store,
    launcher,
    repoRoot: process.cwd(),
  });
  return command.run(options.invocation, options);
}
