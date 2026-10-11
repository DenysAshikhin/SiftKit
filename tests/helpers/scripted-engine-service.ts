import type { MockPlannerResponseInput } from '../../src/planner-protocol/mock-response.ts';
import type { RepoSearchExecutionRequest, RepoSearchExecutionResult } from '../../src/repo-search/types.ts';
import { RecordingEngineService } from './recording-engine-service.ts';

/** One engine call: scripted planner turns, fixed or computed from the request, or an engine failure. */
export type ScriptedCall = MockPlannerResponseInput[] | ((request: RepoSearchExecutionRequest) => MockPlannerResponseInput[]) | Error;

/** A final answer the repo-agent loop accepts: the answer, then the same answer after its completion review. */
export function finalAnswer(content: string): MockPlannerResponseInput[] {
  return [{ content }, { content }];
}

/** Planner turns that fail the auto-reviewer twice, so the approval escalates to its human gate. */
export const ESCALATING_VERDICTS: MockPlannerResponseInput[] = [
  { content: '{"action":"tool","toolName":"git","args":{"operation":"grep","pattern":"x","path":"src2"}}' },
  { content: '{"action":"tool","toolName":"git","args":{"operation":"grep","pattern":"x","path":"src2"}}' },
];

/**
 * The real engine with scripted planner responses: orchestrator parent phases consume `parent`
 * in order, every worker consumes `children` in order. An unscripted call fails loudly.
 */
export class ScriptedEngineService extends RecordingEngineService {
  readonly parent: ScriptedCall[] = [];
  readonly children: ScriptedCall[] = [];

  override executeRepoSearch(request: RepoSearchExecutionRequest): Promise<RepoSearchExecutionResult> {
    const queue = request.taskKind === 'orchestrator' ? this.parent : this.children;
    const next = queue.shift();
    if (next === undefined) {
      return Promise.reject(new Error(`Unscripted ${request.taskKind ?? 'repo-search'} call: ${request.prompt.slice(0, 120)}`));
    }
    if (next instanceof Error) return Promise.reject(next);
    return super.executeRepoSearch({ ...request, mockResponses: typeof next === 'function' ? next(request) : next });
  }

  /** Recorded prompts of one side, in call order. */
  prompts(side: 'parent' | 'children'): string[] {
    return this.repoSearchRequests
      .filter((request) => (request.taskKind === 'orchestrator') === (side === 'parent'))
      .map((request) => request.prompt);
  }
}
