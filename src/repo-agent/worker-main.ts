import { CliProgressRenderer } from '../cli/progress-renderer.js';
import { StatusServerApiClient } from '../cli/status-server-api-client.js';
import { isMainModule } from '../lib/paths.js';
import { z } from '../lib/zod.js';
import { RepoAgentBoundaryWaiter } from './boundary-waiter.js';
import { RepoAgentRunStore } from './run-store.js';
import { RepoAgentWorker } from './worker.js';

const WorkerArgumentsSchema = z.tuple([
  z.string().uuid(),
  z.string().min(1),
]);

export async function runRepoAgentWorkerMain(argv: string[]): Promise<void> {
  const [runId, runsRoot] = WorkerArgumentsSchema.parse(argv);
  const store = new RepoAgentRunStore(runsRoot);
  const request = store.readRequest(runId);
  const boundaryWaiter = new RepoAgentBoundaryWaiter({ store, runId });
  const worker = new RepoAgentWorker({
    store,
    apiClient: new StatusServerApiClient(),
    progressRenderer: CliProgressRenderer.forCli(
      process.stderr,
      'repo-agent',
      request.progress,
    ),
    boundaryWaiter,
  });
  await worker.run(runId);
}

if (isMainModule(import.meta.url)) {
  void runRepoAgentWorkerMain(process.argv.slice(2)).catch((error) => {
    process.stderr.write(
      `Repo-agent worker failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
