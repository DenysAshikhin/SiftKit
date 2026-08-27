import React from 'react';
import { buildToolActivityRing, getToolActivityLabel } from '../lib/tool-activity-ring';
import type { ChatToolCallMessage } from '../types';

export function ToolCallCard({ message }: { message: ChatToolCallMessage }) {
  const group = buildToolActivityRing([message])[0];
  if (!group) return null;
  const output = message.toolCallOutput ?? message.toolCallOutputSnippet ?? '';
  return (
    <div className="tcall">
      <details>
        <summary className="tcall-summary">
          <span className={group.state === 'failed' ? 'tbad' : 'tstatus'}>
            {getToolActivityLabel(group)}
          </span>
          <span className="tcall-expand">details</span>
        </summary>
        <div className="tcall-details">
          <div className="mono">command: {message.toolCallCommand}</div>
          {output ? <pre className="mono">{output}</pre> : null}
        </div>
      </details>
    </div>
  );
}
