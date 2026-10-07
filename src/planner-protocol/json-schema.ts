import type { AgentLoopFinishAction } from '../agent-loop/types.ts';
import { JsonObjectSchema, type JsonObject } from '../lib/json-types.ts';
import type { InferenceToolDefinition } from '../llm-protocol/types.ts';
import { z } from '../lib/zod.ts';

type PlannerToolDefinitionBase = {
  type: 'function';
  exampleArgs: JsonObject;
  function: InferenceToolDefinition['function'];
};

export type PlannerToolDefinition = PlannerToolDefinitionBase & (
  | { kind: 'tool'; argumentSchema: z.ZodType<JsonObject> }
  | { kind: 'finish'; argumentSchema: z.ZodType<AgentLoopFinishAction> }
);

/**
 * Planner schemas ship as subschemas (provider `function.parameters`, `anyOf` action branches),
 * not JSON Schema documents, so the `$schema` dialect key Zod emits at the root is dropped.
 * It is pure prompt cost on every tool, every turn.
 */
export function buildPlannerJsonSchema(schema: z.ZodType): JsonObject {
  const { $schema: _dialect, ...parameters } = z.toJSONSchema(schema, { io: 'input' });
  return JsonObjectSchema.parse(parameters);
}
