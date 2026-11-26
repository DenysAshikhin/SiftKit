import React from 'react';

import {
  isOrchestratorTerminalPhase,
  type OrchestratorActivity,
  type OrchestratorPendingApproval,
  type OrchestratorPhase,
  type OrchestratorRunState,
  type RepoAgentDecision,
} from '@siftkit/contracts';
import { useNow } from '../hooks/useNow.ts';
import { usePaneFollow } from '../hooks/usePaneFollow.ts';
import { approachLabel, budgetSummary, endedApproaches, formatElapsed, orchestratorSteps, phaseTone, runElapsedMs, taskCounts } from '../orchestrator-view.ts';
import { MarkdownContent } from './MarkdownContent.tsx';
import { OrchestratorConversation, OrchestratorConversationHeader } from './OrchestratorConversation.tsx';
import { OrchestratorRunLine } from './OrchestratorRunLine.tsx';
import { OrchestratorTaskRow } from './OrchestratorTaskRow.tsx';

function ApprovalRequest({ pending, onDecide }: { pending: OrchestratorPendingApproval; onDecide(decision: RepoAgentDecision): void }) {
  const [reason, setReason] = React.useState('');
  return (
    <section className="approval-card" aria-label="Orchestrator approval required">
      {pending.kind === 'child'
        ? <div className="approval-card-head">Subagent for {pending.taskId} requests <code>{pending.toolName}</code></div>
        : <div className="approval-card-head">Orchestrator check in {pending.cwd}{pending.taskId === null ? ' (final verification)' : ` for ${pending.taskId}`}</div>}
      <pre className="approval-command">{pending.command}</pre>
      {pending.kind === 'child' && pending.reviewPayload ? <p className="approval-payload">{pending.reviewPayload}</p> : null}
      <input aria-label="Deny reason" value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Reason to deny…" />
      <div className="approval-actions">
        <button type="button" className="send" onClick={() => onDecide({ decision: 'approve' })}>Approve</button>
        <button type="button" className="approval-reject" disabled={!reason.trim()} onClick={() => onDecide({ decision: 'deny', reason: reason.trim() })}>Deny</button>
        <button type="button" className="mini-btn approval-abort" onClick={() => onDecide({ decision: 'abort' })}>Abort run</button>
      </div>
    </section>
  );
}

/** Elapsed times are shown to the second. */
const CLOCK_TICK_MS = 1000;

export function OrchestratorRunPanel({ state, activity, workPhase, lastMessage, onDecide, onAbort }: {
  state: OrchestratorRunState;
  activity: OrchestratorActivity | null;
  workPhase: OrchestratorPhase | null;
  lastMessage: string | null;
  onDecide(decision: RepoAgentDecision): void;
  onAbort(): void;
}) {
  const live = !isOrchestratorTerminalPhase(state.phase);
  const now = useNow(CLOCK_TICK_MS, live);
  const completed = state.tasks.filter((task) => task.status === 'completed').length;
  const approach = approachLabel(state);
  const ended = endedApproaches(state);
  const parent = activity?.parent ?? null;
  const conversation = usePaneFollow(null);
  const tasks = usePaneFollow('.orch-task.open');
  return (
    <section className="orchestrator-run" aria-label="Orchestrator run">
      <header className="orch-head">
        {live ? <span className="live-dot" /> : null}
        <span className="orch-title">Run</span>
        <span className={`bdg ${phaseTone(state.phase)}`}>{state.phase}</span>
        {state.tasks.length > 0 ? <span className="hint">{completed} of {state.tasks.length} tasks complete</span> : null}
        {live ? <button type="button" className="send stop orch-stop" onClick={onAbort}>Stop</button> : null}
      </header>
      <div className="orch-meta">
        {state.planPath ? <span>plan <code>{state.planPath}</code></span> : null}
        {approach ? <span>approach <b>{approach}</b></span> : null}
        <span>approval <b>{state.request.approval}</b></span>
        <span>elapsed <b>{formatElapsed(runElapsedMs(state, now))}</b></span>
        <span>budget <b>{budgetSummary(state, now)}</b></span>
      </div>
      {lastMessage ? <p className="hint orch-last">{lastMessage}</p> : null}
      <ol className="orch-phases" aria-label="Run phases">
        {orchestratorSteps(state.phase, workPhase).map((step) => (
          <li key={step.label} className={`orch-phase ${step.status}`} data-status={step.status} aria-label={`${step.label} step`}>
            <i />{step.label}
          </li>
        ))}
      </ol>
      {state.approval ? <ApprovalRequest key={state.approval.approvalId} pending={state.approval} onDecide={onDecide} /> : null}
      {state.failure ? <div className="err-banner"><span>{state.failure.message}</span></div> : null}
      {state.summary === null ? null : (
        <section className="orch-summary" aria-label="Final answer" tabIndex={0}>
          <header className="orch-title">Final answer</header>
          <div className="markdown-body"><MarkdownContent content={state.summary} /></div>
        </section>
      )}
      <div className="orch-panes">
        <section className="orch-pane" aria-label="Orchestrator" tabIndex={0}
          ref={conversation.paneRef} onScroll={conversation.onScroll} onClick={conversation.onClick}>
          <OrchestratorConversationHeader parent={parent} live={live} />
          {parent === null ? null : <OrchestratorConversation parent={parent} parentRunId={state.parentRunIds.at(-1) ?? null} />}
          <OrchestratorRunLine state={state} />
        </section>
        <section className="orch-pane" aria-label="Tasks" tabIndex={0} ref={tasks.paneRef} onScroll={tasks.onScroll} onClick={tasks.onClick}>
          <header className="orch-pane-head">
            <span className="orch-title">Tasks</span>
            <span className="hint">{taskCounts(state.tasks)}</span>
          </header>
          <ol className="orch-tasks">
            {state.tasks.map((task) => <OrchestratorTaskRow key={task.taskId} task={task} state={state} activity={activity} now={now} />)}
          </ol>
          {ended.length > 0 ? (
            <ol className="orch-history" aria-label="Earlier approaches">
              {ended.map((entry) => (
                <li key={entry.number}><b>{entry.number}. {entry.title}</b> {entry.outcome}: {entry.lesson}</li>
              ))}
            </ol>
          ) : null}
          {state.retiredTasks.length > 0 ? (
            <ul className="orch-history" aria-label="Retired tasks">
              {state.retiredTasks.map((task) => (
                <li key={task.taskId}><b>{task.taskId}</b> {task.title} · approach {task.approach} · {task.status}: {task.reason}</li>
              ))}
            </ul>
          ) : null}
        </section>
      </div>
    </section>
  );
}
