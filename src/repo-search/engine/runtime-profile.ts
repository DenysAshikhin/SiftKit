import { REPO_AGENT_DEFAULT_MAX_TURNS } from '@siftkit/contracts';
import type { RunToolArgs } from '../repo-tool-arguments.ts';
import type { RepoSearchLoopKind, RepoSearchTaskKind } from '../task-kind.ts';
import {
  RUN_FULL_DOWNGRADE_NOTICE,
  RunFullOutputGate,
  type RunFullOutputDecision,
  ValidationCommandOutputPolicy,
} from './validation-command-output-policy.ts';

export const REPO_AGENT_VALIDATION_OUTPUT_LINE_LIMIT = 50;
export const DEFAULT_MAX_INVALID_RESPONSES = 3;
export const ORCHESTRATOR_MAX_INVALID_RESPONSES = 5;

export class RepoSearchRuntimeProfile {
  private readonly validationOutputPolicy = new ValidationCommandOutputPolicy(
    REPO_AGENT_VALIDATION_OUTPUT_LINE_LIMIT,
  );
  private readonly runFullOutputGate = new RunFullOutputGate();

  private readonly taskKind: RepoSearchTaskKind;

  constructor(taskKind: RepoSearchTaskKind) {
    this.taskKind = taskKind;
  }

  resolveMaxTurns(
    requestedMaxTurns: number | undefined,
    standardDefault: number,
  ): number {
    if (requestedMaxTurns !== undefined) {
      return requestedMaxTurns;
    }
    return this.taskKind === 'repo-agent'
      ? REPO_AGENT_DEFAULT_MAX_TURNS
      : standardDefault;
  }

  /**
   * How many invalid responses in a row end the loop. The orchestrator writes the largest tool arguments of a
   * long, costly conversation, so a few slips there must not end a run that is otherwise healthy.
   */
  resolveMaxInvalidResponses(requestedMaxInvalidResponses: number | undefined): number {
    if (requestedMaxInvalidResponses !== undefined) return requestedMaxInvalidResponses;
    return this.taskKind === 'orchestrator' ? ORCHESTRATOR_MAX_INVALID_RESPONSES : DEFAULT_MAX_INVALID_RESPONSES;
  }

  get loopKind(): RepoSearchLoopKind {
    if (this.taskKind === 'plan') return 'repo-search';
    return this.taskKind === 'orchestrator' ? 'repo-agent' : this.taskKind;
  }

  /**
   * How the loop reacts when a turn's prompt overflows the context budget. repo-search already
   * holds the evidence it needs, so it stops and answers from the transcript as it stands;
   * repo-agent and chat still have work left to do and must survive the overflow by compacting.
   */
  get contextOverflowPolicy(): 'force_answer' | 'compact' {
    return this.loopKind === 'repo-search' ? 'force_answer' : 'compact';
  }

  beginRun(call: RunToolArgs): RunFullOutputDecision {
    return this.runFullOutputGate.beginRun({
      command: call.command,
      requestedMode: call.outputMode ?? 'auto',
      isValidationCommand: this.taskKind === 'repo-agent'
        && this.validationOutputPolicy.isValidationCommand(call.command),
    });
  }

  applyRunOutput(options: {
    call: RunToolArgs;
    output: string;
    decision: RunFullOutputDecision;
  }): string {
    if (options.decision.kind === 'duplicate') {
      throw new Error('Duplicate full-output retry cannot be applied to run output.');
    }
    const output = this.taskKind === 'repo-agent'
      ? this.validationOutputPolicy.apply({
          command: options.call.command,
          output: options.output,
          outputMode: options.decision.effectiveMode,
        })
      : options.output;
    return options.decision.downgraded
      ? `${output}\n\n${RUN_FULL_DOWNGRADE_NOTICE}`
      : output;
  }
}
