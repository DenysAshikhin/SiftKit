import type { LlamaCppContentPart, LlamaCppResponseFormat, LlamaCppToolDefinition } from '../llm-protocol/types.js';
import { serializeProtocolMessages, type ChatMessage } from './planner-protocol.js';

// ChatML role markers. Built from a code-point concatenation so the token
// sequence does not appear verbatim in sources or diffs.
const IM_START = String.fromCodePoint(0x3c, 0x7c, 0x69, 0x6d, 0x5f, 0x73, 0x74, 0x61, 0x72, 0x74, 0x7c, 0x3e);
const IM_END = String.fromCodePoint(0x3c, 0x7c, 0x69, 0x6d, 0x5f, 0x65, 0x6e, 0x64, 0x7c, 0x3e);

/** ChatML tail that opens the assistant turn the model is asked to complete. */
export const WIRE_GENERATION_PROMPT = `${IM_START}assistant\n`;

export type WirePromptInput = {
  messages: readonly ChatMessage[];
  tools: readonly LlamaCppToolDefinition[];
  /** Serialized alongside the tools when the request constrains the response shape. */
  responseFormat: LlamaCppResponseFormat | null | undefined;
  includeReasoningContent: boolean;
};

function renderContent(content: string | LlamaCppContentPart[] | null | undefined): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .filter((part) => part.type === 'text')
      .map((part) => part.text ?? '')
      .join('');
  }
  return '';
}

function renderLeadingExtras(input: WirePromptInput): string {
  const sections: string[] = [];
  if (input.tools.length > 0) {
    sections.push(JSON.stringify(input.tools));
  }
  if (input.responseFormat !== null && input.responseFormat !== undefined) {
    sections.push(JSON.stringify(input.responseFormat));
  }
  return sections.join('\n');
}

/**
 * Renders the prompt the model receives: wire-serialized messages plus tool schemas,
 * wrapped in ChatML markers. Image parts are excluded here and accounted for by the
 * caller's per-image token allowance.
 */
export function renderWirePrompt(input: WirePromptInput): string {
  const protocolMessages = serializeProtocolMessages([...input.messages], input.includeReasoningContent);
  const leadingExtras = renderLeadingExtras(input);

  if (protocolMessages.length === 0) {
    const leadingBlock = leadingExtras ? `${IM_START}system\n${leadingExtras}${IM_END}\n` : '';
    return leadingBlock + WIRE_GENERATION_PROMPT;
  }

  const blocks = protocolMessages.map((message, index) => {
    const sections: string[] = [];
    if (typeof message.reasoning_content === 'string' && message.reasoning_content) {
      sections.push(message.reasoning_content);
    }
    const contentText = renderContent(message.content);
    if (contentText) {
      sections.push(contentText);
    }
    if (index === 0 && leadingExtras) {
      sections.push(leadingExtras);
    }
    if (message.tool_calls !== undefined) {
      sections.push(JSON.stringify({ tool_calls: message.tool_calls }));
    }
    if (message.tool_call_id !== undefined) {
      sections.push(JSON.stringify({ tool_call_id: message.tool_call_id }));
    }
    return `${IM_START}${message.role}\n${sections.join('\n')}${IM_END}\n`;
  });

  return blocks.join('') + WIRE_GENERATION_PROMPT;
}