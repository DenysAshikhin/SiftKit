import React from 'react';

import {
  isOrchestratorOpenTaskStatus,
  orchestratorCheckFailure,
  type OrchestratorActivity,
  type OrchestratorAttempt,
  type OrchestratorChildActivity,
  type OrchestratorReviewRecord,
  type OrchestratorRunState,
  type OrchestratorTaskClaim,
  type OrchestratorTaskState,
} from '@siftkit/contracts';
import { runLogsHref } from '../lib/format.ts';
import { attemptSummary, contextPercent, formatElapsed, nowDoing, taskTone, waitReason } from '../orchestrator-view.ts';

const VISIBLE_FINDINGS = 3;

/** The orchestrator's latest review of the task: its verdict, how many criteria held, and its first findings. */
function ReviewSummary({ review }: { review: OrchestratorReviewRecord }) {
  const met = review.criteria.filter((criterion) => criterion.met).length;
  const hidden = review.findings.length - VISIBLE_FINDINGS;
  return (
    <div className="orch-review">
      <p className={review.verdict === 'pass' ? 'ok' : 'bad'}>
        {`Review ${review.verdict === 'pass' ? 'passed' : 'failed'}: ${met} of ${review.criteria.length} criteria met`}
      </p>
      {review.findings.length === 0 ? null : (
        <ul className="orchestrator-findings">
          {review.findings.slice(0, VISIBLE_FINDINGS).map((finding) => (
            <li key={`${finding.path}:${finding.line}:${finding.issue}`}>{`${finding.path}:${finding.line} ${finding.issue}`}</li>
          ))}
          {hidden > 0 ? <li className="hint">+{hidden} more findings</li> : null}
        </ul>
      )}
    </div>
  );
}

function AgentCard({ child, claim, attempt, writePaths, now }: {
  child: OrchestratorChildActivity;
  claim: OrchestratorTaskClaim | undefined;
  attempt: OrchestratorAttempt | undefined;
  writePaths: readonly string[];
  now: number;
}) {
  const turnWidth = child.maxTurns === null ? 0 : Math.min(100, (child.turn / child.maxTurns) * 100);
  return (
    <div className="orch-agent" aria-label={`Agent ${child.childRunId}`}>
      <div className="orch-agent-head">
        <span>agent <b>{child.childRunId.slice(0, 8)}</b></span>
        <span>turn <b>{child.turn}</b>/{child.maxTurns ?? '?'}</span>
        {claim === undefined ? null : <span>ctx <b>{contextPercent(child, claim)}%</b></span>}
        {attempt === undefined ? null : <span>{formatElapsed(now - Date.parse(attempt.reservedAtUtc))}</span>}
        <a className="mini-btn" href={runLogsHref(child.childRunId)}>Transcript</a>
      </div>
      <div className="orch-turnbar"><i style={{ width: `${turnWidth}%` }} /></div>
      <div className="orch-agent-tools">
        {child.tools.length === 0 ? <div className="hint">{child.waitingForModel ? 'Waiting for the model…' : 'No tool calls yet.'}</div> : null}
        {child.tools.map((tool) => (
          <div key={tool.toolCallId} className={`tcall-summary orch-tool ${tool.status}`}>
            {tool.status === 'running' ? <span className="sp" /> : <span className={`dot ${tool.status === 'failed' ? 'bad' : 'ok'}`} />}
            <span className="orch-tool-kind">{tool.activityKind}</span>
            <span className="orch-tool-command">{tool.command}</span>
          </div>
        ))}
      </div>
      <div className="orch-agent-foot">
        {writePaths.length === 0 ? 'read-only' : <>writes <code>{writePaths.join(' · ')}</code></>}
      </div>
    </div>
  );
}

function AttemptResult({ attempt }: { attempt: OrchestratorAttempt }) {
  const { result } = attempt;
  if (result === null) return null;
  return (
    <div className="orch-checks">
      {result.checks.map((check, index) => {
        if (check.check.kind !== 'command') return null;
        const failure = orchestratorCheckFailure(check);
        return <div key={index} className={failure === null ? 'ok' : 'bad'}>{failure ?? `✓ ${check.check.command}`}</div>;
      })}
      {result.passed
        ? <div className="ok">Attempt {attempt.attempt} passed · {result.changedPaths.length} files changed</div>
        : <div className="bad">{`Attempt ${attempt.attempt}: ${result.outcome.replace(/_/gu, ' ')} after ${result.submissions} submissions`}</div>}
    </div>
  );
}

export function OrchestratorTaskRow({ task, state, activity, now }: {
  task: OrchestratorTaskState;
  state: OrchestratorRunState;
  activity: OrchestratorActivity | null;
  now: number;
}) {
  const planned = state.plan?.tasks.find((candidate) => candidate.id === task.taskId);
  const child = activity?.children.find((candidate) => candidate.taskId === task.taskId) ?? null;
  const claim = activity?.schedule?.claims.find((candidate) => candidate.taskId === task.taskId);
  const latest = state.attempts.filter((attempt) => attempt.taskId === task.taskId).at(-1);
  const open = isOrchestratorOpenTaskStatus(task.status);
  // Opens when the task starts; after that the user's toggle wins, so settling never collapses the row.
  const [expanded, setExpanded] = React.useState(open);
  React.useEffect(() => {
    if (open) setExpanded(true);
  }, [open]);
  const role = claim === undefined ? null : claim.mutating ? 'writer' : 'read-only';
  return (
    <li className={open ? 'orch-task open' : 'orch-task'}>
      <details open={expanded} onToggle={(event) => setExpanded(event.currentTarget.open)}>
        <summary className="orch-task-summary">
          {open ? <span className="sp" /> : <span className={`dot ${taskTone(task.status)}`} />}
          <span className="orch-task-name">
            {planned?.title ?? task.taskId}
            <small>{[task.taskId, planned?.workerPresetId, role].filter((part) => part !== undefined && part !== null).join(' · ')}</small>
          </span>
          <span className="orch-task-doing">{nowDoing(task, child) ?? waitReason(task, state, activity)}</span>
          <span className="orch-task-attempts">{attemptSummary(task.taskId, state.attempts)}</span>
          <span className={`bdg ${taskTone(task.status)}`}>{task.status}</span>
        </summary>
        {child !== null ? (
          <AgentCard child={child} claim={claim} now={now} writePaths={planned?.writePaths ?? []}
            attempt={state.attempts.find((attempt) => attempt.childRunId === child.childRunId)} />
        ) : null}
        {child === null && latest !== undefined ? <AttemptResult attempt={latest} /> : null}
        {task.review ? <ReviewSummary review={task.review} /> : null}
      </details>
    </li>
  );
}
