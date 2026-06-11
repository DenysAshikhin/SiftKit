import type { JsonObject, LlamaCppToolCall, LlamaCppUsage, NormalizedLlamaCppChatResponse } from './types.js';
import { LlamaCppToolCallParser } from './tool-call-parser.js';

export type LlamaCppStreamingAssemblerOptions = {
  structuralRepeatLimit?: number;
};

type StreamingToolCallChunk = {
  id: string;
  name: string;
  argumentsText: string;
};

type RawDelta = {
  content?: unknown;
  reasoning_content?: unknown;
  thinking?: unknown;
  reasoning?: unknown;
  tool_calls?: Array<{
    index?: number;
    id?: unknown;
    function?: {
      name?: unknown;
      arguments?: unknown;
    };
  }>;
};

type RawChoiceDelta = {
  delta?: RawDelta;
};

export class LlamaCppStreamingResponseAssembler {
  private readonly parser: LlamaCppToolCallParser;
  private readonly structuralRepeatLimit: number;
  private readonly toolChunks = new Map<number, StreamingToolCallChunk>();
  private contentText = '';
  private reasoningText = '';
  private earlyStopReason: string | null = null;

  constructor(allowedToolNames: readonly string[], options: LlamaCppStreamingAssemblerOptions = {}) {
    this.parser = new LlamaCppToolCallParser(allowedToolNames);
    this.structuralRepeatLimit = Math.max(1, Math.floor(options.structuralRepeatLimit ?? 96));
  }

  ingestChoiceDelta(choice: RawChoiceDelta): void {
    if (this.earlyStopReason) return;
    const delta = choice.delta;
    if (!delta) return;

    this.contentText += getString(delta.content);
    this.reasoningText += getString(delta.reasoning_content) || getString(delta.thinking) || getString(delta.reasoning);
    for (const toolCall of delta.tool_calls || []) {
      const index = Number.isInteger(toolCall.index) ? Number(toolCall.index) : this.toolChunks.size;
      const current = this.toolChunks.get(index) || { id: `call_${index}`, name: '', argumentsText: '' };
      const id = getString(toolCall.id);
      const name = getString(toolCall.function?.name);
      const argumentsText = getString(toolCall.function?.arguments);
      this.toolChunks.set(index, {
        id: id || current.id,
        name: name || current.name,
        argumentsText: `${current.argumentsText}${argumentsText}`,
      });
    }

    const runawayText = getRunawayText(this.reasoningText, this.structuralRepeatLimit)
      || getRunawayText(this.contentText, this.structuralRepeatLimit);
    if (runawayText) {
      this.earlyStopReason = `Stopped early because the streaming response appeared to enter runaway structural repetition: ${runawayText}`;
    }
  }

  toResponse(usage: LlamaCppUsage): NormalizedLlamaCppChatResponse {
    return {
      text: this.contentText,
      reasoningText: this.reasoningText,
      toolCalls: this.getToolCalls(),
      usage,
      raw: {},
      stoppedEarly: this.earlyStopReason !== null,
      ...(this.earlyStopReason ? { earlyStopReason: this.earlyStopReason } : {}),
    };
  }

  private getToolCalls(): LlamaCppToolCall[] {
    return Array.from(this.toolChunks.entries())
      .sort(([left], [right]) => left - right)
      .map(([, chunk]) => this.parser.parseToolCall({
        id: chunk.id,
        type: 'function',
        function: {
          name: chunk.name,
          arguments: chunk.argumentsText || '{}',
        },
      }))
      .filter((toolCall): toolCall is LlamaCppToolCall => toolCall !== null);
  }
}

function getString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function getRunawayText(text: string, limit: number): string | null {
  if (text.length < limit) return null;
  const last = text[text.length - 1];
  if (!last || !/[^\w\s]/u.test(last)) return null;
  let repeated = 0;
  for (let index = text.length - 1; index >= 0 && text[index] === last; index -= 1) {
    repeated += 1;
  }
  return repeated >= limit ? last.repeat(Math.min(repeated, 16)) : null;
}
