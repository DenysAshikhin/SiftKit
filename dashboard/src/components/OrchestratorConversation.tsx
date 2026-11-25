import React from 'react';

import type { OrchestratorParentActivity, OrchestratorParentTurn } from '@siftkit/contracts';

import { toLiveContextUsage } from '../lib/contextBar.ts';
import { plural, runLogsHref } from '../lib/format.ts';

/** Turns shown in full, and tool calls shown in each; the rest fold. */
const TURNS_SHOWN = 3;
const CALLS_SHOWN = 3;

function parentStatus(parent: OrchestratorParentActivity, live: boolean): string {
  if (!live) return 'finished';
  if (parent.parked) return 'released its model while children work';
  if (parent.waitingForModel) return 'waiting for the model';
  return 'thinking';
}

function ParentCalls({ tools }: { tools: OrchestratorParentTurn['tools'] }) {
  return tools.map((tool) => (
    <details key={tool.toolCallId} className={`orch-parent-tool ${tool.status}`}>
      <summary>
        {tool.status === 'running' ? <span className="sp" /> : <span className={`dot ${tool.status === 'failed' ? 'bad' : 'ok'}`} />}
        <span className="orch-tool-command">{tool.command}</span>
      </summary>
      {tool.output === '' ? null : <pre>{tool.output}</pre>}
    </details>
  ));
}

function TurnBody({ turn }: { turn: OrchestratorParentTurn }) {
  const earlier = turn.tools.slice(0, -CALLS_SHOWN);
  return (
    <>
      {turn.thinking === '' ? null : (
        <details className="orch-parent-thinking">
          <summary>Thinking</summary>
          <pre>{turn.thinking}</pre>
        </details>
      )}
      {turn.text === '' ? null : <pre className="orch-parent-text">{turn.text}</pre>}
      {earlier.length === 0 ? null : (
        <details className="orch-parent-more">
          <summary>{plural(earlier.length, 'earlier call')}</summary>
          <ParentCalls tools={earlier} />
        </details>
      )}
      <ParentCalls tools={turn.tools.slice(-CALLS_SHOWN)} />
    </>
  );
}

export function OrchestratorConversationHeader({ parent, live }: { parent: OrchestratorParentActivity | null; live: boolean }) {
  return (
    <header className="orch-pane-head">
      {live && parent !== null && !parent.parked ? <span className="sp" /> : <span className="dot idle" />}
      <span className="orch-title">Orchestrator</span>
      {parent === null ? null : (
        <>
          <span className="hint">{parentStatus(parent, live)}</span>
          <span className="hint">{plural(parent.turnCount, 'turn')}</span>
          <span className="hint">
            context {parent.promptTokens.toLocaleString()} / {parent.contextTokens.toLocaleString()} ({Math.round(toLiveContextUsage(parent.promptTokens, parent.contextTokens, true).ratio * 100)}%)
          </span>
        </>
      )}
    </header>
  );
}

/** The orchestrator's own conversation as it happens: its prompt, its earlier turns folded, and its latest ones. */
export function OrchestratorConversation({ parent, parentRunId }: { parent: OrchestratorParentActivity; parentRunId: string | null }) {
  const older = parent.turns.slice(0, -TURNS_SHOWN);
  const dropped = parent.turnCount - parent.turns.length;
  return (
    <div className="orch-parent">
      {parent.prompt === null ? null : (
        <details className="orch-parent-prompt">
          <summary>Prompt</summary>
          <h4>System</h4>
          <pre>{parent.prompt.system}</pre>
          <h4>Task</h4>
          <pre>{parent.prompt.user}</pre>
        </details>
      )}
      {dropped > 0 && parentRunId !== null ? <a className="hint" href={runLogsHref(parentRunId)}>Full transcript ({plural(dropped, 'older turn')})</a> : null}
      {older.length === 0 ? null : (
        <details className="orch-parent-older">
          <summary>Earlier turns ({older.length})</summary>
          <div className="orch-older-box">
            {older.map((turn) => (
              <details key={turn.turn} className="orch-older-turn">
                <summary>turn {turn.turn} · {plural(turn.tools.length, 'call')}</summary>
                <TurnBody turn={turn} />
              </details>
            ))}
          </div>
        </details>
      )}
      <ol className="orch-parent-turns">
        {parent.turns.slice(-TURNS_SHOWN).map((turn) => (
          <li key={turn.turn} className="orch-parent-turn">
            <div className="orch-parent-turn-head">turn {turn.turn}</div>
            <TurnBody turn={turn} />
          </li>
        ))}
      </ol>
    </div>
  );
}
