import type { OrchestratorToolCall } from '../repo-tool-arguments.ts';

/** A host tool's answer: the text the model reads, and whether the call did what it asked. */
export type OrchestratorToolOutcome = { ok: boolean; output: string };

/** The orchestrator run that executes its parent's own tools; a throw ends the parent run. */
export interface OrchestratorToolHost {
  execute(call: OrchestratorToolCall): Promise<OrchestratorToolOutcome>;
  /** The run's state as text: what replaces the parent's transcript when it outgrows the context. */
  contextDigest(): string;
}
