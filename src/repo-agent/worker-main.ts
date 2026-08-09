import { runRepoAgentWorkerMain } from './worker-runner.js';

void runRepoAgentWorkerMain(process.argv.slice(2)).catch((error) => {
  process.stderr.write(
    `Repo-agent worker failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
