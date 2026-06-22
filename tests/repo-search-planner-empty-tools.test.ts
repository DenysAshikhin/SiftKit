import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { buildRepoSearchPlannerActionJsonSchema } from '../src/providers/structured-output-schema.js';
import { buildPlannerRequestPromptReserveText } from '../src/repo-search/planner-protocol.js';

const ActionOneOfSchema = z
  .object({
    oneOf: z.array(
      z
        .object({
          properties: z
            .object({ action: z.object({ const: z.string().optional() }).passthrough().optional() })
            .passthrough()
            .optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();
const PlannerRequestBodySchema = z
  .object({
    response_format: z.object({ json_schema: z.object({ schema: ActionOneOfSchema }) }),
  })
  .passthrough();

test('zero tool definitions produce a finish-only action schema', () => {
  const schema = ActionOneOfSchema.parse(buildRepoSearchPlannerActionJsonSchema({ toolDefinitions: [] }));
  assert.equal(schema.oneOf.length, 1);
  assert.equal(schema.oneOf[0].properties?.action?.const, 'finish');
});

test('planner request with empty toolDefinitions emits a finish-only schema (no repo tools)', () => {
  const body = PlannerRequestBodySchema.parse(JSON.parse(buildPlannerRequestPromptReserveText({
    stage: 'planner_action',
    model: 'mock',
    maxTokens: 256,
    messageRoles: ['system', 'user'],
    thinkingEnabled: false,
    reasoningContentEnabled: false,
    preserveThinking: false,
    toolDefinitions: [],
  })));
  const actionSchemas = body.response_format.json_schema.schema.oneOf;
  assert.equal(actionSchemas.length, 1);
  assert.equal(actionSchemas[0].properties?.action?.const, 'finish');
});
