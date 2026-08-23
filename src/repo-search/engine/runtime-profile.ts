import { REPO_AGENT_DEFAULT_MAX_TURNS } from '@siftkit/contracts';
import { z } from '../../lib/zod.js';
import type { RunToolArgs } from '../repo-tool-arguments.js';
import type { RepoSearchLoopKind, RepoSearchTaskKind } from '../task-kind.js';
import {
  RUN_FULL_DOWNGRADE_NOTICE,
  RunFullOutputGate,
  type RunFullOutputDecision,
  ValidationCommandOutputPolicy,
} from './validation-command-output-policy.js';

export const REPO_AGENT_VALIDATION_OUTPUT_LINE_LIMIT = 50;

export const ContextOverflowPolicySchema = z.enum(['compact', 'fail']);
export type ContextOverflowPolicy = z.infer<typeof ContextOverflowPolicySchema>;

export class RepoSearchRuntimeProfile {
  private readonly validationOutputPolicy = new ValidationCommandOutputPolicy(
    REPO_AGENT_VALIDATION_OUTPUT_LINE_LIMIT,
  );
  private readonly runFullOutputGate = new RunFullOutputGate();

  constructor(private readonly taskKind: RepoSearchTaskKind) {}

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

  get contextOverflowPolicy(): ContextOverflowPolicy {
    return this.taskKind === 'repo-agent' ? 'fail' : 'compact';
  }

  get loopKind(): RepoSearchLoopKind {
    return this.taskKind === 'plan' ? 'repo-search' : this.taskKind;
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
