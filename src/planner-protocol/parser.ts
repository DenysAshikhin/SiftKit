import { JsonObjectSchema } from '../lib/json-types.js';
import type { JsonObject } from '../lib/json-types.js';
import { z } from '../lib/zod.js';
import type { PlannerToolDefinition } from './json-schema.js';

export const PlannerToolActionEnvelopeSchema = z.strictObject({
  action: z.literal('tool'),
  toolName: z.string().trim().min(1),
  args: JsonObjectSchema,
});

export const PlannerBatchCallSchema = PlannerToolActionEnvelopeSchema.omit({ action: true });

export const PlannerToolBatchEnvelopeSchema = z.strictObject({
  action: z.literal('tool_batch'),
  calls: z.array(PlannerBatchCallSchema).min(1),
});

export type PlannerToolActionEnvelope = z.infer<typeof PlannerToolActionEnvelopeSchema>;
export type PlannerBatchCall = z.infer<typeof PlannerBatchCallSchema>;
export type PlannerToolBatchEnvelope = z.infer<typeof PlannerToolBatchEnvelopeSchema>;

export function getPlannerToolDefinition(
  toolDefinitions: readonly PlannerToolDefinition[],
  toolName: string,
): PlannerToolDefinition | null {
  const normalizedToolName = toolName.trim().toLowerCase();
  return toolDefinitions.find(
    ({ function: definition }) => definition.name.trim().toLowerCase() === normalizedToolName,
  ) ?? null;
}

export function requirePlannerToolDefinition(
  toolDefinitions: readonly PlannerToolDefinition[],
  toolName: string,
): PlannerToolDefinition {
  const definition = getPlannerToolDefinition(toolDefinitions, toolName);
  if (!definition) {
    throw new Error(`planner tool "${toolName}" is unavailable`);
  }
  return definition;
}

export function parsePlannerToolAction(
  parsed: JsonObject,
  toolDefinitions: readonly PlannerToolDefinition[],
): PlannerToolActionEnvelope | null {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed) || !('action' in parsed) || parsed.action !== 'tool') {
    return null;
  }
  const result = PlannerToolActionEnvelopeSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Provider returned an invalid planner tool action: ${result.error.issues[0]?.message ?? 'schema validation failed'}`);
  }
  requirePlannerToolDefinition(toolDefinitions, result.data.toolName);
  return result.data;
}

export function parsePlannerToolBatchAction(
  parsed: JsonObject,
  toolDefinitions: readonly PlannerToolDefinition[],
): PlannerBatchCall[] {
  const result = PlannerToolBatchEnvelopeSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Provider returned an invalid planner tool batch action: ${result.error.issues[0]?.message ?? 'schema validation failed'}`);
  }
  return result.data.calls.map((call, index) => {
    try {
      requirePlannerToolDefinition(toolDefinitions, call.toolName);
      return call;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Provider returned an invalid planner tool batch action: call ${index + 1} uses unavailable ${message}`);
    }
  });
}
