import type { RepoSearchExecutionRequest, RepoSearchExecutionResult } from '../../src/repo-search/types.js';
import type { SummaryRequest, SummaryResult } from '../../src/summary/types.js';
import { StatusEngineService } from '../../src/status-server/engine-service.js';
import { getActiveModelPreset } from '../../src/config/getters.js';
import type { SiftConfig } from '../../src/config/types.js';

/** One engine call in execution order: its prompt or question, and the model profile it ran on. */
export type RecordedExecution = { text: string; modelPresetId: string | null };

function executedModelPresetId(config: SiftConfig | undefined): string | null {
  return config ? getActiveModelPreset(config).id : null;
}

/** The real engine, recording every repo-search and summary request exactly as a route handed it over. */
export class RecordingEngineService extends StatusEngineService {
  readonly repoSearchRequests: RepoSearchExecutionRequest[] = [];
  readonly summaryRequests: SummaryRequest[] = [];
  readonly executions: RecordedExecution[] = [];

  override executeRepoSearch(request: RepoSearchExecutionRequest): Promise<RepoSearchExecutionResult> {
    this.repoSearchRequests.push(request);
    this.executions.push({ text: request.prompt, modelPresetId: executedModelPresetId(request.config) });
    return super.executeRepoSearch(request);
  }

  override summarize(request: SummaryRequest): Promise<SummaryResult> {
    this.summaryRequests.push(request);
    this.executions.push({ text: request.question, modelPresetId: executedModelPresetId(request.config) });
    return super.summarize(request);
  }

  /** The recorded repo-search request whose prompt contains `needle`. */
  requireRepoSearch(needle: string): RepoSearchExecutionRequest {
    const request = this.repoSearchRequests.find((entry) => entry.prompt.includes(needle));
    if (!request) throw new Error(`Expected a recorded repo-search request containing ${JSON.stringify(needle)}.`);
    return request;
  }

  requireSummary(needle: string): SummaryRequest {
    const request = this.summaryRequests.find((entry) => entry.question.includes(needle));
    if (!request) throw new Error(`Expected a recorded summary request asking ${JSON.stringify(needle)}.`);
    return request;
  }
}
