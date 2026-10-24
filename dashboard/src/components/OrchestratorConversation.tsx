import React from 'react';

import type { OrchestratorParentActivity, OrchestratorParentTurn } from '@siftkit/contracts';

function parentStatus(parent: OrchestratorParentActivity, live: boolean): string {
  if (!live) return 'finished';
  if (parent.parked) return 'released its model while children work';
  if (parent.waitingForModel) return 'waiting for the model';
  return 'thinking';
}

function ParentTurn({ turn, latest }: { turn: OrchestratorParentTurn; latest: boolean }) {
  return (
    <li className="orch-parent-turn">
      <div className="orch-parent-turn-head">turn {turn.turn}</div>
      {turn.thinking === '' ? null : (
        <details className="orch-parent-thinking" open={latest}>
          <summary>Thinking</summary>
          <pre>{turn.thinking}</pre>
        </details>
      )}
      {turn.text === '' ? null : <pre className="orch-parent-text">{turn.text}</pre>}
      {turn.tools.map((tool) => (
        <details key={tool.toolCallId} className={`orch-parent-tool ${tool.status}`}>
          <summary>
            {tool.status === 'running' ? <span className="sp" /> : <span className={`dot ${tool.status === 'failed' ? 'bad' : 'ok'}`} />}
            <span className="orch-tool-command">{tool.command}</span>
          </summary>
          {tool.output === '' ? null : <pre>{tool.output}</pre>}
        </details>
      ))}
    </li>
  );
}

/** The orchestrator's own conversation as it happens: its prompt, then each recent turn's thinking and tool calls. */
export function OrchestratorConversation({ parent, live }: { parent: OrchestratorParentActivity; live: boolean }) {
  const latestTurn = parent.turns.at(-1)?.turn ?? null;
  const hidden = parent.turnCount - parent.turns.length;
  return (
    <section className="orch-parent" aria-label="Orchestrator conversation">
      <header className="orch-parent-head">
        {live && !parent.parked ? <span className="sp" /> : <span className="dot idle" />}
        <span className="orch-title">Orchestrator</span>
        <span className="hint">{parentStatus(parent, live)}</span>
        <span className="hint">{parent.turnCount} turns</span>
        <span className="hint">{parent.promptTokens.toLocaleString()} prompt tokens</span>
      </header>
      {parent.prompt === null ? null : (
        <details className="orch-parent-prompt">
          <summary>Prompt</summary>
          <h4>System</h4>
          <pre>{parent.prompt.system}</pre>
          <h4>Task</h4>
          <pre>{parent.prompt.user}</pre>
        </details>
      )}
      {hidden > 0 ? <p className="hint">{hidden} earlier turns are in the run transcript.</p> : null}
      <ol className="orch-parent-turns">
        {parent.turns.map((turn) => <ParentTurn key={turn.turn} turn={turn} latest={turn.turn === latestTurn} />)}
      </ol>
    </section>
  );
}
