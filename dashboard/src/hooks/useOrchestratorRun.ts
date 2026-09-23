import React from 'react';

import { isOrchestratorTerminalPhase, type ApprovalMode, type OrchestratorRunState, type RepoAgentDecision } from '@siftkit/contracts';
import { toError } from '../../../src/lib/errors.js';
import {
  abortOrchestrator,
  decideOrchestrator,
  followOrchestrator,
  getOrchestratorStatus,
  listOrchestratorRuns,
  startOrchestrator,
} from '../orchestrator-api.js';

export type OrchestratorStartInput = { presetId: string; approval: ApprovalMode; task: string | null; planPath: string | null };

/** Shows the repository's latest parent run, follows it while live, and forwards the user's controls. */
export function useOrchestratorRun(repoRoot: string | null) {
  const [state, setState] = React.useState<OrchestratorRunState | null>(null);
  const [lastMessage, setLastMessage] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const follow = React.useRef<AbortController | null>(null);

  const attach = React.useCallback((initial: OrchestratorRunState) => {
    follow.current?.abort();
    const controller = new AbortController();
    follow.current = controller;
    setState(initial);
    setError(null);
    if (isOrchestratorTerminalPhase(initial.phase)) return;
    void (async () => {
      try {
        const stream = followOrchestrator(initial.runId, 0, controller.signal);
        for (;;) {
          const next = await stream.next();
          if (controller.signal.aborted) return;
          if (next.done) {
            setState(next.value);
            return;
          }
          setLastMessage(next.value.message);
          const current = await getOrchestratorStatus(initial.runId);
          if (!controller.signal.aborted) setState(current);
        }
      } catch (caught) {
        if (!controller.signal.aborted) setError(toError(caught).message);
      }
    })();
  }, []);

  React.useEffect(() => {
    setState(null);
    setLastMessage(null);
    setError(null);
    if (repoRoot === null) return undefined;
    let cancelled = false;
    listOrchestratorRuns(repoRoot).then((runs) => {
      const latest = runs[0];
      if (!cancelled && latest !== undefined) attach(latest);
    }, (caught) => { if (!cancelled) setError(toError(caught).message); });
    return () => {
      cancelled = true;
      follow.current?.abort();
    };
  }, [repoRoot, attach]);

  async function run(action: () => Promise<OrchestratorRunState>, reattach: boolean): Promise<void> {
    try {
      const next = await action();
      if (reattach) attach(next);
      else setState(next);
    } catch (caught) {
      setError(toError(caught).message);
    }
  }

  return {
    state,
    lastMessage,
    error,
    start(input: OrchestratorStartInput): Promise<void> {
      if (repoRoot === null) throw new Error('An orchestrator run needs a repository folder.');
      setLastMessage(null);
      return run(() => startOrchestrator({ submissionId: crypto.randomUUID(), repoRoot, ...input }), true);
    },
    decide(decision: RepoAgentDecision): Promise<void> {
      const pending = state?.approval;
      if (!state || !pending) throw new Error('No orchestrator approval is pending.');
      return run(() => decideOrchestrator({ runId: state.runId, approvalId: pending.approval.approvalId, ...decision }), false);
    },
    abort(): Promise<void> {
      if (!state) throw new Error('No orchestrator run to stop.');
      return run(() => abortOrchestrator(state.runId), false);
    },
  };
}
