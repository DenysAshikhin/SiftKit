import { CliProgressRenderer } from '../cli/progress-renderer.js';
import { StatusServerApiClient } from '../cli/status-server-api-client.js';
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
  const boundaryWaiter = new RepoAgentBoundaryWaiter({ store, runId });
  const worker = new RepoAgentWorker({
    store,
    apiClient: new StatusServerApiClient(),
    progressRenderer: CliProgressRenderer.forCli(process.stderr, 'repo-agent', false),
    boundaryWaiter,
  });
  await worker.run(runId);
}
