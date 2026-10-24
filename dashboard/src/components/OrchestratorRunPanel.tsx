import React from 'react';

import {
  isOrchestratorTerminalPhase,
  type OrchestratorActivity,
  type OrchestratorPendingApproval,
  type OrchestratorPhase,
  type OrchestratorRunState,
  type OrchestratorSchedule,
  type RepoAgentDecision,
} from '@siftkit/contracts';
import { useNow } from '../hooks/useNow.ts';
import { formatElapsed, orchestratorSteps, phaseTone, runElapsedMs } from '../orchestrator-view.ts';
import { OrchestratorConversation } from './OrchestratorConversation.tsx';
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

function SlotMeter({ schedule }: { schedule: OrchestratorSchedule }) {
  return (
    <div className="orch-slots" aria-label="Scheduler slots">
      <span className="orch-slot-group" title={schedule.writerUsed ? 'writer slot in use' : 'writer slot free'}>
        writer <span className={schedule.writerUsed ? 'orch-slot writer used' : 'orch-slot writer'} />
      </span>
      {schedule.models.map((model) => (
        <span key={model.modelId} className="orch-slot-group" title={`${model.used} of ${model.slots} ${model.modelId} slots in use`}>
          {model.modelId}
          {Array.from({ length: model.slots }, (_, index) => (
            <span key={index} className={index < model.used ? 'orch-slot used' : 'orch-slot'} />
          ))}
        </span>
      ))}
    </div>
  );
}

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
  const schedule = activity?.schedule ?? null;
  const completed = state.tasks.filter((task) => task.status === 'completed').length;
  return (
    <section className="orchestrator-run" aria-label="Orchestrator run">
      <header className="orch-head">
        {live ? <span className="live-dot" /> : null}
        <span className="orch-title">Orchestrator</span>
        <span className={`bdg ${phaseTone(state.phase)}`}>{state.phase}</span>
        {state.tasks.length > 0 ? <span className="hint">{completed} of {state.tasks.length} tasks complete</span> : null}
        {live ? <button type="button" className="send stop orch-stop" onClick={onAbort}>Stop</button> : null}
      </header>
      <div className="orch-meta">
        {state.planPath ? <span>plan <code>{state.planPath}</code></span> : null}
        <span>approval <b>{state.request.approval}</b></span>
        <span>elapsed <b>{formatElapsed(runElapsedMs(state, now))}</b></span>
      </div>
      {lastMessage ? <p className="hint orch-last">{lastMessage}</p> : null}
      <ol className="orch-phases" aria-label="Run phases">
        {orchestratorSteps(state.phase, workPhase).map((step) => (
          <li key={step.label} className={`orch-phase ${step.status}`} data-status={step.status} aria-label={`${step.label} step`}>
            <i />{step.label}
          </li>
        ))}
      </ol>
      {schedule !== null ? <SlotMeter schedule={schedule} /> : null}
      <ol className="orch-tasks">
        {state.tasks.map((task) => <OrchestratorTaskRow key={task.taskId} task={task} state={state} activity={activity} now={now} />)}
      </ol>
      {activity?.parent ? <OrchestratorConversation parent={activity.parent} live={live} /> : null}
      {state.approval ? <ApprovalRequest key={state.approval.approvalId} pending={state.approval} onDecide={onDecide} /> : null}
      {state.failure ? <div className="err-banner"><span>{state.failure.message}</span></div> : null}
    </section>
  );
}
