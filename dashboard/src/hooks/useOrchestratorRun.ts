import React from 'react';

import {
  isOrchestratorTerminalPhase,
  type ApprovalMode,
  type OrchestratorActivity,
  type OrchestratorPhase,
  type OrchestratorRunState,
  type RepoAgentDecision,
} from '@siftkit/contracts';
import { toError } from '../../../src/lib/errors.ts';
import {
  abortOrchestrator,
  decideOrchestrator,
  followOrchestrator,
  readOrchestratorRun,
  startOrchestrator,
} from '../orchestrator-api.ts';

export type OrchestratorStartInput = {
  sessionId: string;
  repoRoot: string;
  presetId: string;
  approval: ApprovalMode;
  task: string | null;
  planPath: string | null;
};

/**
 * Shows one session's own parent run, by the run ID that session records, and follows its progress and
 * live activity. A run started elsewhere reaches the board only through the session it belongs to.
 */
export function useOrchestratorRun(runId: string | null) {
  const [state, setState] = React.useState<OrchestratorRunState | null>(null);
  const [activity, setActivity] = React.useState<OrchestratorActivity | null>(null);
  // The last phase that was real work, so an approval pause or a stop still shows where the run was.
  const [workPhase, setWorkPhase] = React.useState<OrchestratorPhase | null>(null);
  const [lastMessage, setLastMessage] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const follow = React.useRef<AbortController | null>(null);

  const attach = React.useCallback((initial: OrchestratorRunState) => {
    follow.current?.abort();
    const controller = new AbortController();
    follow.current = controller;
    setState(initial);
    setActivity(null);
    setWorkPhase(null);
    setError(null);
    // A terminal run is followed too: its replayed events restore the last message and work phase.
    void (async () => {
      try {
        const stream = followOrchestrator(initial.runId, 0, controller.signal);
        for (;;) {
          const next = await stream.next();
          if (controller.signal.aborted) return;
          if (next.done) {
            setActivity(null);
            setState(next.value);
            return;
          }
          const item = next.value;
          if (item.kind === 'activity') {
            setActivity(item.activity);
            continue;
          }
          // Each frame carries the state its events produced; no status refetch is needed.
          const { events, state: committed } = item.progress;
          setLastMessage(events.at(-1)?.message ?? null);
          const worked = events.filter((event) => event.phase !== 'approval_required' && !isOrchestratorTerminalPhase(event.phase)).at(-1);
          if (worked !== undefined) setWorkPhase(worked.phase);
          setState(committed);
        }
      } catch (caught) {
        if (!controller.signal.aborted) setError(toError(caught).message);
      }
    })();
  }, []);

  React.useEffect(() => {
    setState(null);
    setActivity(null);
    setWorkPhase(null);
    setLastMessage(null);
    setError(null);
    if (runId === null) return undefined;
    let cancelled = false;
    readOrchestratorRun(runId).then((state) => {
      if (!cancelled) attach(state);
    }, (caught) => { if (!cancelled) setError(toError(caught).message); });
    return () => {
      cancelled = true;
      follow.current?.abort();
    };
  }, [runId, attach]);

  return {
    state,
    activity,
    workPhase,
    lastMessage,
    error,
    start(input: OrchestratorStartInput): Promise<void> {
      setLastMessage(null);
      return startOrchestrator({ submissionId: crypto.randomUUID(), ...input })
        .then(attach, (caught) => setError(toError(caught).message));
    },
    decide(decision: RepoAgentDecision): Promise<void> {
      const pending = state?.approval;
      if (!state || !pending) throw new Error('No orchestrator approval is pending.');
      return decideOrchestrator({ runId: state.runId, approvalId: pending.approvalId, ...decision })
        .then(setState, (caught) => setError(toError(caught).message));
    },
    abort(): Promise<void> {
      if (!state) throw new Error('No orchestrator run to stop.');
      return abortOrchestrator(state.runId).then(setState, (caught) => setError(toError(caught).message));
    },
  };
}
