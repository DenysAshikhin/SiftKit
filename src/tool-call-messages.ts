export type ToolTranscriptAction = {
  tool_name: string;
  args: Record<string, unknown>;
};

export type ToolTranscriptMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | Array<{ type?: string; text?: string }>;
  reasoning_content?: string | Array<{ type?: string; text?: string }>;
  tool_calls?: Array<{
    id?: string;
    type?: string;
    function?: {
      name?: string;
      arguments?: unknown;
    };
  }>;
  tool_call_id?: string;
};

export function buildAssistantToolCallMessage(
  action: ToolTranscriptAction,
  toolCallId: string,
  thinkingText = '',
): ToolTranscriptMessage {
  return {
    role: 'assistant',
    content: '',
    tool_calls: [{
      id: toolCallId,
      type: 'function',
      function: {
        name: action.tool_name,
        arguments: JSON.stringify(action.args),
      },
    }],
    ...(thinkingText ? { reasoning_content: thinkingText } : {}),
  };
}

export function appendToolCallExchange(
  messages: ToolTranscriptMessage[],
  action: ToolTranscriptAction,
  toolCallId: string,
  toolContent: string,
  thinkingText = '',
): void {
  messages.push(buildAssistantToolCallMessage(action, toolCallId, thinkingText));
  messages.push({
    role: 'tool',
    tool_call_id: toolCallId,
    content: toolContent,
  });
}

export type ToolBatchOutcome = {
  action: ToolTranscriptAction;
  toolCallId: string;
  toolContent: string;
};

export function appendToolBatchExchange(
  messages: ToolTranscriptMessage[],
  outcomes: ToolBatchOutcome[],
  thinkingText = '',
): void {
  if (outcomes.length === 0) {
    return;
  }
  messages.push({
    role: 'assistant',
    content: '',
    tool_calls: outcomes.map(({ action, toolCallId }) => ({
      id: toolCallId,
      type: 'function',
      function: {
        name: action.tool_name,
        arguments: JSON.stringify(action.args),
      },
    })),
    ...(thinkingText ? { reasoning_content: thinkingText } : {}),
  });
  for (const { toolCallId, toolContent } of outcomes) {
    messages.push({
      role: 'tool',
      tool_call_id: toolCallId,
      content: toolContent,
    });
  }
}

export function upsertTrailingUserMessage(
  messages: ToolTranscriptMessage[],
  existingIndex: number,
  content: string,
): number {
  if (existingIndex >= 0 && existingIndex < messages.length) {
    messages[existingIndex] = {
      role: 'user',
      content,
    };
    return existingIndex;
  }
  messages.push({
    role: 'user',
    content,
  });
  return messages.length - 1;
}
