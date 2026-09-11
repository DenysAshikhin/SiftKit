import React, { useState } from 'react';
import { buildToolActivityRing, getToolActivityLabel } from '../lib/tool-activity-ring';
import type { ChatToolCallMessage } from '../types';

export function ToolCallCard({ message }: { message: ChatToolCallMessage }) {
  const [expanded, setExpanded] = useState(false);
  const group = buildToolActivityRing([message])[0];
  if (!group) return null;
  const output = message.toolCallOutput ?? message.toolCallOutputSnippet ?? '';
  return (
    <div className="tcall">
      {message.toolCallExecutionState === 'uncertain'
        ? <p role="status">This tool may have run. Verify its effects before retrying.</p>
        : message.toolCallExecutionState === 'not_started' ? <p role="status">This tool did not start.</p> : null}
      <details onToggle={(event) => setExpanded(event.currentTarget.open)}>
        <summary className="tcall-summary">
          <span className={group.state === 'failed' ? 'tbad' : 'tstatus'}>
            {getToolActivityLabel(group)}
          </span>
          <span className="tcall-expand">details</span>
        </summary>
        {expanded && <div className="tcall-details">
          <div className="mono">command: {message.toolCallCommand}</div>
          {output ? <pre className="mono">{output}</pre> : null}
        </div>}
      </details>
    </div>
  );
}
