import type { AgentLoopFinishAction } from '../agent-loop/types.js';
import { JsonObjectSchema, type JsonObject } from '../lib/json-types.js';
import type { LlamaCppToolParameterSchema } from '../llm-protocol/types.js';
import { z } from '../lib/zod.js';

type PlannerToolDefinitionBase = {
  type: 'function';
  exampleArgs: JsonObject;
  function: {
    name: string;
    description: string;
    parameters: LlamaCppToolParameterSchema;
  };
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
