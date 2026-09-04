import { JsonObjectSchema } from '../lib/json-types.js';
import { z } from '../lib/zod.js';
import { StreamStopSchema, type InferenceToolCall, type StreamStop } from '../llm-protocol/types.js';

export const MockPlannerToolCallSchema = z.strictObject({
  id: z.string().trim().min(1).optional(),
  name: z.string().trim().min(1),
  arguments: JsonObjectSchema,
});

const StopReasonSchema = z.string().trim().min(1).nullable().default(null);

export const MockPlannerResponseSchema = z.strictObject({
  content: z.string().default(''),
  thinking: z.string().default(''),
  toolCalls: z.array(MockPlannerToolCallSchema).default([]),
  /** Simulates a client-side early stop with this reason. */
  earlyStopReason: StopReasonSchema,
  /** Simulates a backend `choices[].eos_reason`. */
  backendEosReason: StopReasonSchema,
  /** Simulates a `choices[].finish_reason` such as `'length'`. */
  finishReason: StopReasonSchema,
});
export const MockPlannerResponsesSchema = z.array(MockPlannerResponseSchema);

export type MockPlannerResponse = z.infer<typeof MockPlannerResponseSchema>;
export type MockPlannerResponseInput = z.input<typeof MockPlannerResponseSchema>;

export function parseMockPlannerResponse(value: MockPlannerResponseInput, responseIndex: number): {
  content: string;
  thinking: string;
  toolCalls: InferenceToolCall[];
  stop: StreamStop;
} {
  const response = MockPlannerResponseSchema.parse(value);
  return {
    content: response.content,
    thinking: response.thinking,
    toolCalls: response.toolCalls.map((toolCall, toolCallIndex) => ({
      id: toolCall.id ?? `mock_${responseIndex + 1}_${toolCallIndex + 1}`,
      type: 'function',
      function: {
        name: toolCall.name,
        arguments: JSON.stringify(toolCall.arguments),
      },
    })),
    stop: StreamStopSchema.parse({
      earlyStopReason: response.earlyStopReason,
      backendEosReason: response.backendEosReason,
      finishReason: response.finishReason,
    }),
  };
}
