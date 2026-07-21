import React from 'react';
import { getToolRunningLabel } from '../lib/tool-status';
import { formatCompactTokenCount } from '../lib/format';
import type { ChatMessage } from '../types';

export function ToolCallCard({ message }: { message: ChatMessage }) {
  const command = typeof message.toolCallCommand === 'string' ? message.toolCallCommand.trim() : '';
  const output = message.toolCallOutput || message.toolCallOutputSnippet || '';
  const isRunning = message.toolCallStatus === 'running';
  const tokenLabel = typeof message.toolCallPromptTokenCount === 'number'
    ? `${formatCompactTokenCount(message.toolCallPromptTokenCount)} tok `
    : '';

  return (
    <div className="tcall">
      <header>
        {isRunning ? <span className="sp" /> : null}
        <span className="tn">{command}</span>
        {isRunning ? (
          <span>{getToolRunningLabel(command)}</span>
        ) : (
          <span className="tok">✓ {tokenLabel}loaded</span>
        )}
      </header>
      {!isRunning && output ? (
        <details>
          <summary>result</summary>
          <pre className="mono">{output}</pre>
        </details>
      ) : null}
    </div>
  );
}
