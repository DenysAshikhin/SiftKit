import React from 'react';

import {
  ORCHESTRATOR_MAX_ATTEMPTS,
  isOrchestratorTerminalPhase,
  orchestratorCheckFailure,
  type OrchestratorAttempt,
  type OrchestratorDriftReview,
  type OrchestratorPendingApproval,
  type OrchestratorRunState,
  type RepoAgentDecision,
} from '@siftkit/contracts';

const VISIBLE_FINDINGS = 3;

function attemptLabel(attempt: OrchestratorAttempt): string {
  const kind = attempt.purpose === 'implementation' ? 'Implementation attempt' : 'Drift correction';
  return `${kind} ${attempt.attempt} of ${ORCHESTRATOR_MAX_ATTEMPTS}`;
}

function DriftSummary({ review }: { review: OrchestratorDriftReview }) {
  if (review.status !== 'actionable') return <p className="hint">No actionable drift</p>;
  const hidden = review.findings.length - VISIBLE_FINDINGS;
  return (
    <ul className="orchestrator-findings">
      {review.findings.slice(0, VISIBLE_FINDINGS).map((finding) => <li key={finding.id}>{finding.title}</li>)}
      {hidden > 0 ? <li className="hint">+{hidden} more findings</li> : null}
    </ul>
  );
}

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

export function OrchestratorRunPanel({ state, lastMessage, onDecide, onAbort }: {
  state: OrchestratorRunState;
  lastMessage: string | null;
  onDecide(decision: RepoAgentDecision): void;
  onAbort(): void;
}) {
  const titles = new Map((state.plan?.tasks ?? []).map((task) => [task.id, task.title]));
  return (
    <section className="orchestrator-run" aria-label="Orchestrator run">
      <div className="orchestrator-run-head">
        <span>Orchestrator</span>
        <span className="bdg">{state.phase}</span>
        {isOrchestratorTerminalPhase(state.phase) ? null : <button type="button" className="send stop" onClick={onAbort}>Stop</button>}
      </div>
      {state.planPath ? <code>{state.planPath}</code> : null}
      {lastMessage ? <p className="hint">{lastMessage}</p> : null}
      <ol className="orchestrator-tasks">
        {state.tasks.map((task) => {
          const latest = state.attempts.filter((attempt) => attempt.taskId === task.taskId).at(-1);
          const failed = latest?.result && !latest.result.passed
            ? latest.result.checks.flatMap((result) => orchestratorCheckFailure(result) ?? [])
            : [];
          return (
            <li key={task.taskId}>
              <span>{titles.get(task.taskId) ?? task.taskId}</span> <span className="bdg">{task.status}</span>
              {latest ? <div>{attemptLabel(latest)}</div> : null}
              {failed.map((failure, index) => <div key={index} className="bad">{failure}</div>)}
              {task.driftReview ? <DriftSummary review={task.driftReview} /> : null}
            </li>
          );
        })}
      </ol>
      {state.approval ? <ApprovalRequest key={state.approval.approvalId} pending={state.approval} onDecide={onDecide} /> : null}
      {state.failure ? <div className="err-banner"><span>{state.failure.message}</span></div> : null}
    </section>
  );
}
