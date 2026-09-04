import type { InferenceContentPart, InferenceToolDefinition } from '../llm-protocol/types.js';
import { countContentImages } from '../llm-protocol/image-attachments.js';
import { serializeProtocolMessages, type ChatMessage } from './planner-protocol.js';

// ChatML role markers. Built from a code-point concatenation so the token
// sequence does not appear verbatim in sources or diffs.
const IM_START = String.fromCodePoint(0x3c, 0x7c, 0x69, 0x6d, 0x5f, 0x73, 0x74, 0x61, 0x72, 0x74, 0x7c, 0x3e);
const IM_END = String.fromCodePoint(0x3c, 0x7c, 0x69, 0x6d, 0x5f, 0x65, 0x6e, 0x64, 0x7c, 0x3e);

/** ChatML tail that opens the assistant turn the model is asked to complete. */
export const WIRE_GENERATION_PROMPT = `${IM_START}assistant\n`;

export type WirePromptInput = {
  messages: readonly ChatMessage[];
  tools: readonly InferenceToolDefinition[];
  includeReasoningContent: boolean;
};

/** The rendered prompt plus the image parts it left out, which the caller budgets separately. */
export type WirePrompt = {
  text: string;
  imageCount: number;
};

function renderContent(content: string | InferenceContentPart[] | null | undefined): string {
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

/**
 * Renders the prompt the model receives: wire-serialized messages plus tool schemas,
 * wrapped in ChatML markers. Image parts carry no text here, so they are reported as a
 * count for the caller's per-image token allowance instead.
 */
export function renderWirePrompt(input: WirePromptInput): WirePrompt {
  const protocolMessages = serializeProtocolMessages(input.messages, input.includeReasoningContent);
  const toolSchemas = input.tools.length > 0 ? JSON.stringify(input.tools) : '';
  const imageCount = input.messages.reduce((total, message) => total + countContentImages(message.content), 0);

  if (protocolMessages.length === 0) {
    const leadingBlock = toolSchemas ? `${IM_START}system\n${toolSchemas}${IM_END}\n` : '';
    return { text: leadingBlock + WIRE_GENERATION_PROMPT, imageCount };
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
    if (index === 0 && toolSchemas) {
      sections.push(toolSchemas);
    }
    if (message.tool_calls !== undefined) {
      sections.push(JSON.stringify({ tool_calls: message.tool_calls }));
    }
    if (message.tool_call_id !== undefined) {
      sections.push(JSON.stringify({ tool_call_id: message.tool_call_id }));
    }
    return `${IM_START}${message.role}\n${sections.join('\n')}${IM_END}\n`;
  });

  return { text: blocks.join('') + WIRE_GENERATION_PROMPT, imageCount };
}
