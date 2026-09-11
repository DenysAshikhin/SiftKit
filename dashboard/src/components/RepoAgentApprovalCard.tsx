import React from 'react';

import type { DurableChatApproval } from '@siftkit/contracts';
import type { RepoAgentDecision } from '../api';
import { formatDate } from '../lib/format';

export function RepoAgentApprovalCard({ approval, onDecide }: {
  approval: DurableChatApproval;
  onDecide(decision: RepoAgentDecision): void;
}) {
  const [rejecting, setRejecting] = React.useState(false);
  const [reason, setReason] = React.useState('');
  const expiresAt = Date.parse(approval.expiresAtUtc);
  const [expired, setExpired] = React.useState(() => Date.now() >= expiresAt);
  React.useEffect(() => {
    const remaining = expiresAt - Date.now();
    setExpired(remaining <= 0);
    if (remaining <= 0) return;
    const timer = setTimeout(() => setExpired(true), remaining);
    return () => clearTimeout(timer);
  }, [expiresAt]);
  const disabled = expired || !approval.actionable || approval.outcome !== null;
  function decide(decision: RepoAgentDecision): void {
    if (!disabled && Date.now() < expiresAt) onDecide(decision);
  }
  return (
    <section className="approval-card" aria-label="Repo-agent approval required">
      <div className="approval-card-head">Approval required — <code>{approval.toolName}</code></div>
      <pre className="approval-command">{approval.command}</pre>
      <p>{expired ? 'Approval expired. ' : 'Approval expires: '}<time dateTime={approval.expiresAtUtc}>{formatDate(approval.expiresAtUtc)}</time></p>
      {approval.reviewPayload ? <p className="approval-payload"><strong>Review payload:</strong> {approval.reviewPayload}</p> : null}
      {rejecting ? (
        <div className="approval-reject-form">
          <textarea aria-label="Rejection reason" value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Why should this command be rejected?" />
          <div className="approval-actions">
            <button type="button" className="approval-reject" disabled={disabled || !reason.trim()} onClick={() => decide({ decision: 'deny', reason: reason.trim() })}>Submit rejection</button>
            <button type="button" className="mini-btn" onClick={() => setRejecting(false)}>Cancel</button>
          </div>
        </div>
      ) : (
        <div className="approval-actions">
          <button type="button" className="send" disabled={disabled} onClick={() => decide({ decision: 'approve' })}>Approve</button>
          <button type="button" className="approval-reject" disabled={disabled} onClick={() => setRejecting(true)}>Reject…</button>
          <button type="button" className="mini-btn approval-abort" disabled={disabled} onClick={() => decide({ decision: 'abort' })}>Abort</button>
        </div>
      )}
    </section>
  );
}

export function RepoAgentApprovalRow({ decision, command, reason, decidedAtUtc }: {
  decision: RepoAgentDecision['decision'];
  command: string;
  reason: string | null;
  decidedAtUtc: string;
}) {
  const verdict = decision === 'approve' ? '✓ Approved' : decision === 'deny' ? '✕ Rejected' : '⏹ Stopped';
  return (
    <div className={decision === 'approve' ? 'approval-row ok' : 'approval-row bad'}>
      <span className="verdict">{verdict}</span>
      <span className="cmd-inline">{command}</span>
      <span>· <span className="who">User</span> · {formatDate(decidedAtUtc)}</span>
      {reason ? <span>· {reason}</span> : null}
    </div>
  );
}
