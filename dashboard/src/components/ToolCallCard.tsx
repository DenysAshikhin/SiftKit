import React from 'react';
import { getToolActivityLabel, type ToolActivityLifecycle } from '../lib/tool-status';
import { formatCompactTokenCount } from '../lib/format';
import type { ChatToolCallMessage } from '../types';

export function ToolCallCard({ message }: { message: ChatToolCallMessage }) {
  const command = message.toolCallCommand;
  const output = message.toolCallOutput ?? message.toolCallOutputSnippet ?? '';
  const isRunning = message.toolCallStatus === 'running';
  const failed = message.toolCallExitCode !== null && message.toolCallExitCode !== 0;
  const lifecycle: ToolActivityLifecycle = isRunning ? 'running' : failed ? 'failed' : 'completed';
  const label = getToolActivityLabel(message.toolCallActivityKind, lifecycle, command);
  const tokenLabel = typeof message.toolCallPromptTokenCount === 'number'
    ? `${formatCompactTokenCount(message.toolCallPromptTokenCount)} tok `
    : '';

  if (isRunning) {
    return (
      <div className="tcall">
        <div className="tcall-summary" role="status">
          <span className="sp" />
          <span className="tstatus">{label}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="tcall">
      <details>
        <summary className="tcall-summary">
          <span className={failed ? 'tbad' : 'tok'}>
            {failed ? '\u2715' : '\u2713'} {tokenLabel}{label}
          </span>
          <span className="tcall-expand">details</span>
        </summary>
        <div className="tcall-details">
          <div className="mono">command: {command}</div>
          {output ? <pre className="mono">{output}</pre> : null}
        </div>
      </details>
    </div>
  );
}
