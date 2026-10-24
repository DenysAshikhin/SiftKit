import type { MockPlannerResponseInput } from '../../src/planner-protocol/mock-response.ts';
import type { OrchestratorToolHost } from '../../src/repo-search/engine/orchestrator-tool-host.ts';
import type { RepoSearchExecutionRequest, RepoSearchExecutionResult } from '../../src/repo-search/types.ts';
import { RecordingEngineService } from './recording-engine-service.ts';

/** One child engine call: scripted planner turns, fixed or computed from the request, or an engine failure. */
export type ScriptedCall = MockPlannerResponseInput[] | ((request: RepoSearchExecutionRequest) => MockPlannerResponseInput[]) | Error;

/** One orchestrator turn: fixed, or computed from the output of the orchestrator tool call just before it. */
export type ParentTurn = MockPlannerResponseInput | ((previousToolOutput: string) => MockPlannerResponseInput);

/** The orchestrator's whole conversation, or an engine failure. */
export type ParentScript = ParentTurn[] | Error;

/** Planner turns that fail the auto-reviewer twice, so the approval escalates past the child's own review. */
export const ESCALATING_VERDICTS: MockPlannerResponseInput[] = [
  { content: '{"action":"tool","toolName":"git","args":{"operation":"grep","pattern":"x","path":"src2"}}' },
  { content: '{"action":"tool","toolName":"git","args":{"operation":"grep","pattern":"x","path":"src2"}}' },
];

/** The child's own auto-reviewer approving its pending action. */
export const APPROVING_VERDICT: MockPlannerResponseInput = { content: '{"verdict":"approve","reason":"Inside the task scope."}' };

/**
 * The real engine with scripted planner responses: each orchestrator conversation consumes one `parent`
 * script, every worker consumes `children` in order. An unscripted call fails loudly.
 */
export class ScriptedEngineService extends RecordingEngineService {
  readonly parent: ParentScript[] = [];
  readonly children: ScriptedCall[] = [];
  private readonly conversations: LazyConversation[] = [];

  override executeRepoSearch(request: RepoSearchExecutionRequest): Promise<RepoSearchExecutionResult> {
    return request.taskKind === 'orchestrator' ? this.converse(request) : this.runChild(request);
  }

  private converse(request: RepoSearchExecutionRequest): Promise<RepoSearchExecutionResult> {
    const next = this.parent.shift();
    if (next === undefined) return Promise.reject(new Error(`Unscripted orchestrator call: ${request.prompt.slice(0, 120)}`));
    if (next instanceof Error) return Promise.reject(next);
    const host = request.orchestratorTools;
    if (host === undefined) return Promise.reject(new Error('An orchestrator conversation needs its tool host.'));
    const conversation = new LazyConversation(next);
    this.conversations.push(conversation);
    return super.executeRepoSearch({ ...request, mockResponses: conversation.turns, orchestratorTools: conversation.wrap(host) });
  }

  private runChild(request: RepoSearchExecutionRequest): Promise<RepoSearchExecutionResult> {
    const next = this.children.shift();
    if (next === undefined) return Promise.reject(new Error(`Unscripted ${request.taskKind ?? 'repo-search'} call: ${request.prompt.slice(0, 120)}`));
    if (next instanceof Error) return Promise.reject(next);
    return super.executeRepoSearch({ ...request, mockResponses: typeof next === 'function' ? next(request) : next });
  }

  /** Every orchestrator tool result the parents read, in order. */
  parentToolOutputs(): string[] {
    return this.conversations.flatMap((conversation) => conversation.outputs);
  }

  /** Recorded prompts of one side, in call order. */
  prompts(side: 'parent' | 'children'): string[] {
    return this.repoSearchRequests
      .filter((request) => (request.taskKind === 'orchestrator') === (side === 'parent'))
      .map((request) => request.prompt);
  }
}

function isFixedTurn(turn: ParentTurn): turn is MockPlannerResponseInput {
  return typeof turn !== 'function';
}

/** Queues fixed turns up to the next computed one, which waits until every tool call queued before it has returned. */
class LazyConversation {
  readonly turns: MockPlannerResponseInput[] = [];
  readonly outputs: string[] = [];
  private readonly pending: ParentTurn[];

  constructor(script: ParentTurn[]) {
    this.pending = [...script];
    this.fill();
  }

  wrap(host: OrchestratorToolHost): OrchestratorToolHost {
    return {
      execute: async (call) => {
        const outcome = await host.execute(call);
        this.outputs.push(outcome.output);
        this.fill();
        return outcome;
      },
      contextDigest: () => host.contextDigest(),
    };
  }

  private fill(): void {
    for (let turn = this.pending[0]; turn !== undefined; turn = this.pending[0]) {
      if (isFixedTurn(turn)) this.turns.push(turn);
      else if (this.outputs.length < this.queuedCalls()) return;
      else this.turns.push(turn(this.outputs.at(-1) ?? ''));
      this.pending.shift();
    }
  }

  private queuedCalls(): number {
    return this.turns.reduce((count, turn) => count + (turn.toolCalls?.length ?? 0), 0);
  }
}
