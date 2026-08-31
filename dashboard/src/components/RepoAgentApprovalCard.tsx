import React from 'react';

import type { ChatStreamApproval } from '@siftkit/contracts';
import type { RepoAgentDecision } from '../api';
import { formatDate } from '../lib/format';

export function RepoAgentApprovalCard({ approval, onDecide }: {
  approval: ChatStreamApproval;
  onDecide(decision: RepoAgentDecision): void;
}) {
  const [rejecting, setRejecting] = React.useState(false);
  const [reason, setReason] = React.useState('');
  return (
    <section className="approval-card" aria-label="Repo-agent approval required">
      <div className="approval-card-head">Approval required — <code>{approval.toolName}</code></div>
      <pre className="approval-command">{approval.command}</pre>
      {approval.reviewPayload ? <p className="approval-payload"><strong>Review payload:</strong> {approval.reviewPayload}</p> : null}
      {rejecting ? (
        <div className="approval-reject-form">
          <textarea aria-label="Rejection reason" value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Why should this command be rejected?" />
          <div className="approval-actions">
            <button type="button" className="approval-reject" disabled={!reason.trim()} onClick={() => onDecide({ decision: 'deny', reason: reason.trim() })}>Submit rejection</button>
            <button type="button" className="mini-btn" onClick={() => setRejecting(false)}>Cancel</button>
          </div>
        </div>
      ) : (
        <div className="approval-actions">
          <button type="button" className="send" onClick={() => onDecide({ decision: 'approve' })}>Approve</button>
          <button type="button" className="approval-reject" onClick={() => setRejecting(true)}>Reject…</button>
          <button type="button" className="mini-btn approval-abort" onClick={() => onDecide({ decision: 'abort' })}>Abort</button>
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
      <span>· <span className="who">You</span> · {formatDate(decidedAtUtc)}</span>
      {reason ? <span>· {reason}</span> : null}
    </div>
  );
}
