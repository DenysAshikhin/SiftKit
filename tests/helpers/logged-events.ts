import { JsonObjectSchema, type JsonObject, type JsonSerializable } from '../../src/lib/json-types.js';
import { z } from '../../src/lib/zod.js';

// Logged events may carry undefined-valued fields; the real JSONL logger drops
// them via JSON.stringify, so normalize the same way before schema-validating.
export function parseLoggedEvent(event: Record<string, JsonSerializable>): JsonObject {
  return JsonObjectSchema.parse(JSON.parse(JSON.stringify(event)));
}

// Logged `turn_new_messages` events carry the planner transcript as arbitrary
// JSON. Parse each message to the fields the assertions read so the access is
// typed without indexing the raw JsonData union.
const PlannerLogMessageSchema = z.object({
  role: z.string(),
  content: z.string().optional(),
  tool_calls: z
    .array(z.object({ function: z.object({ name: z.string(), arguments: z.string() }) }))
    .optional(),
});
export type PlannerLogMessage = z.infer<typeof PlannerLogMessageSchema>;

export function plannerLogMessages(event: JsonObject | undefined): PlannerLogMessage[] {
  const raw = event?.messages;
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.map((message) => PlannerLogMessageSchema.parse(message));
}

/** Content of the user messages the planner received on `turn`, in transcript order. */
export function userMessagesOfTurn(events: readonly JsonObject[], turn: number): string[] {
  const entry = events.find((event) => event.kind === 'turn_new_messages' && event.turn === turn);
  return plannerLogMessages(entry).flatMap((message) => (
    message.role === 'user' && message.content !== undefined ? [message.content] : []
  ));
}
