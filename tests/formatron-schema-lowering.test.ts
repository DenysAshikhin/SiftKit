import assert from 'node:assert/strict';
import test from 'node:test';

import type { LlamaCppResponseFormat } from '../src/llm-protocol/types.js';
import {
  FormatronSchemaLowerer,
  lowerResponseFormatForBackend,
} from '../src/providers/formatron-schema-lowering.js';

test('Formatron lowering passes through formats and schemas that do not need lowering', () => {
  const lowerer = new FormatronSchemaLowerer();
  const jsonObject = { type: 'json_object' } satisfies LlamaCppResponseFormat;
  const scalarSchema = {
    type: 'json_schema',
    json_schema: { name: 'scalar', schema: true },
  } satisfies LlamaCppResponseFormat;

  assert.equal(lowerer.lowerResponseFormat(jsonObject), jsonObject);
  assert.equal(lowerer.lowerResponseFormat(scalarSchema), scalarSchema);
  assert.equal(lowerResponseFormatForBackend('llama', scalarSchema), scalarSchema);
});

test('Formatron lowering recursively normalizes optional properties and only relaxes batch calls', () => {
  const canonical = {
    type: 'json_schema',
    json_schema: {
      name: 'planner',
      strict: true,
      schema: {
        type: 'object',
        required: ['action', 'calls', 7],
        properties: {
          action: { const: 'tool_batch' },
          calls: {
            type: 'array',
            minItems: 1,
            items: {
              anyOf: [
                {
                  type: 'object',
                  required: ['action'],
                  properties: {
                    action: { const: 'read' },
                    path: { type: 'string' },
                    offset: { type: 'number' },
                    raw: false,
                  },
                },
                false,
              ],
            },
          },
          metadata: {
            oneOf: [{ type: 'object', properties: { label: { type: 'string' } } }],
            allOf: [{ type: 'object', properties: { tags: { type: 'array', items: false } } }],
          },
        },
      },
    },
  } satisfies LlamaCppResponseFormat;

  const lowered = new FormatronSchemaLowerer().lowerResponseFormat(canonical);

  assert.deepEqual(lowered, {
    type: 'json_schema',
    json_schema: {
      name: 'planner',
      strict: true,
      schema: {
        type: 'object',
        required: ['action', 'calls', 'metadata'],
        properties: {
          action: { const: 'tool_batch' },
          calls: {
            type: 'array',
            items: {
              anyOf: [
                {
                  type: 'object',
                  required: ['action', 'path', 'offset', 'raw'],
                  properties: {
                    action: { const: 'read' },
                    path: { anyOf: [{ type: 'string' }, { type: 'null' }] },
                    offset: { anyOf: [{ type: 'number' }, { type: 'null' }] },
                    raw: false,
                  },
                },
                false,
              ],
            },
          },
          metadata: {
            anyOf: [
              {
                oneOf: [
                  {
                    type: 'object',
                    properties: { label: { anyOf: [{ type: 'string' }, { type: 'null' }] } },
                    required: ['label'],
                  },
                ],
                allOf: [
                  {
                    type: 'object',
                    properties: {
                      tags: { anyOf: [{ type: 'array', items: false }, { type: 'null' }] },
                    },
                    required: ['tags'],
                  },
                ],
              },
              { type: 'null' },
            ],
          },
        },
      },
    },
  });
  assert.equal(canonical.json_schema.schema.properties.calls.minItems, 1);
});

test('Formatron lowering retains minItems outside discriminated tool batches', () => {
  const responseFormat = {
    type: 'json_schema',
    json_schema: {
      name: 'ordinary-array',
      schema: {
        type: 'object',
        properties: {
          calls: { type: 'array', minItems: 2, items: { type: 'string' } },
        },
      },
    },
  } satisfies LlamaCppResponseFormat;

  const lowered = lowerResponseFormatForBackend('exl3', responseFormat);

  assert.deepEqual(lowered, {
    type: 'json_schema',
    json_schema: {
      name: 'ordinary-array',
      schema: {
        type: 'object',
        properties: {
          calls: {
            anyOf: [{ type: 'array', minItems: 2, items: { type: 'string' } }, { type: 'null' }],
          },
        },
        required: ['calls'],
      },
    },
  });
});
