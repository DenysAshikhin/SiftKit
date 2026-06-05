import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRepoSearchPlannerActionJsonSchema } from '../src/providers/structured-output-schema.js';
import { buildPlannerRequestPromptReserveText } from '../src/repo-search/planner-protocol.js';

test('zero tool definitions produce a finish-only action schema', () => {
  const schema = buildRepoSearchPlannerActionJsonSchema({ toolDefinitions: [] }) as { oneOf: Array<{ properties?: { action?: { const?: string } } }> };
  assert.equal(schema.oneOf.length, 1);
  assert.equal(schema.oneOf[0].properties?.action?.const, 'finish');
});

test('planner request with empty toolDefinitions emits a finish-only schema (no repo tools)', () => {
  const body = JSON.parse(buildPlannerRequestPromptReserveText({
    stage: 'planner_action',
    model: 'mock',
    maxTokens: 256,
    messageRoles: ['system', 'user'],
    thinkingEnabled: false,
    reasoningContentEnabled: false,
    preserveThinking: false,
    toolDefinitions: [],
  })) as { response_format: { json_schema: { schema: { oneOf: Array<{ properties?: { action?: { const?: string } } }> } } } };
  const actionSchemas = body.response_format.json_schema.schema.oneOf;
  assert.equal(actionSchemas.length, 1);
  assert.equal(actionSchemas[0].properties?.action?.const, 'finish');
});
