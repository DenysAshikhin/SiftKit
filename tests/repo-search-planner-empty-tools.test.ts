import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { buildRepoSearchPlannerActionJsonSchema } from '../src/providers/structured-output-schema.js';
import { buildPlannerRequestPromptReserveText } from '../src/repo-search/planner-protocol.js';

// With no tools there is exactly one action variant, so the schema collapses to that variant
// directly — no union wrapper at all. See docs/handoff-oneof-grammar-wedge.md: single-variant
// unions wedge the kbnf grammar engine just as multi-variant ones do.
const FinishActionSchema = z
  .object({
    properties: z
      .object({ action: z.object({ const: z.string().optional() }).passthrough() })
      .passthrough(),
  })
  .passthrough();
const PlannerRequestBodySchema = z
  .object({
    response_format: z.object({ json_schema: z.object({ schema: FinishActionSchema }) }),
  })
  .passthrough();

test('zero tool definitions produce a finish-only action schema with no union wrapper', () => {
  const rawSchema = buildRepoSearchPlannerActionJsonSchema({ toolDefinitions: [] });
  assert.doesNotMatch(JSON.stringify(rawSchema), /"(?:one|any)Of"/u);
  const schema = FinishActionSchema.parse(rawSchema);
  assert.equal(schema.properties.action.const, 'finish');
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
  assert.equal(body.response_format.json_schema.schema.properties.action.const, 'finish');
});
