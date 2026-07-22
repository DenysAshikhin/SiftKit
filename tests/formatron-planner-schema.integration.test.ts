import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';

import { z } from '../src/lib/zod.js';
import { FormatronSchemaLowerer } from '../src/providers/formatron-schema-lowering.js';
import {
  buildLlamaJsonSchemaResponseFormat,
  buildRepoSearchPlannerActionJsonSchema,
} from '../src/providers/structured-output-schema.js';
import { resolveRepoSearchPlannerToolDefinitions } from '../src/repo-search/planner-protocol.js';

const IntegrationResultSchema = z.object({
  compileMs: z.number(),
  results: z.record(z.string(), z.boolean()),
});

const pythonPath = process.env.SIFTKIT_FORMATRON_PYTHON?.trim() ?? '';
const tabbyRoot = process.env.SIFTKIT_TABBY_ROOT?.trim() ?? '';
const modelDir = process.env.SIFTKIT_EXL3_MODEL_DIR?.trim() ?? '';
const integrationConfigured = Boolean(pythonPath && tabbyRoot && modelDir);

test(
  'real Formatron planner grammar compiles quickly and enforces the payload corpus',
  {
    skip: integrationConfigured
      ? false
      : 'Set SIFTKIT_FORMATRON_PYTHON, SIFTKIT_TABBY_ROOT, and SIFTKIT_EXL3_MODEL_DIR.',
    timeout: 60_000,
  },
  () => {
    if (!integrationConfigured) {
      return;
    }

    const canonicalSchema = buildRepoSearchPlannerActionJsonSchema({
      toolDefinitions: resolveRepoSearchPlannerToolDefinitions(['read', 'grep']),
    });
    const lowered = new FormatronSchemaLowerer().lowerResponseFormat(
      buildLlamaJsonSchemaResponseFormat({
        name: 'planner',
        schema: canonicalSchema,
      }),
    );
    if (lowered.type !== 'json_schema') {
      throw new Error('Expected lowered JSON Schema response format.');
    }

    const nullGrep =
      '{"action":"grep","pattern":"planner","path":null,"glob":null,"ignoreCase":null,"literal":null,"context":null,"limit":null}';
    const populatedGrep =
      '{"action":"grep","pattern":"planner","path":"src","glob":"*.ts","ignoreCase":true,"literal":true,"context":2,"limit":20}';
    const corpus = [
      { name: 'direct_all_null', text: nullGrep, expected: true },
      { name: 'direct_all_populated', text: populatedGrep, expected: true },
      {
        name: 'single_batch',
        text: `{"action":"tool_batch","calls":[${nullGrep}]}`,
        expected: true,
      },
      {
        name: 'two_call_batch',
        text: `{"action":"tool_batch","calls":[${nullGrep},{"action":"read","path":"src/lib/model-json.ts","offset":null,"limit":null}]}`,
        expected: true,
      },
      {
        name: 'dangling_value',
        text: '{"action":"grep","pattern":"planner","path":null,"glob":null,"ignoreCase":null,"literal":null,"context":null,"limit":}',
        expected: false,
      },
      {
        name: 'bogus_batch_item',
        text: '{"action":"tool_batch","calls":[{"bogus":1}]}',
        expected: false,
      },
    ];
    const fixturePath = path.resolve('tests', 'fixtures', 'formatron-planner-schema.py');
    const result = spawnSync(pythonPath, [fixturePath], {
      cwd: tabbyRoot,
      encoding: 'utf8',
      input: JSON.stringify({
        tabbyRoot,
        modelDir,
        schema: lowered.json_schema.schema,
        corpus,
      }),
      timeout: 55_000,
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const parsed = IntegrationResultSchema.parse(JSON.parse(result.stdout));
    assert.ok(parsed.compileMs < 5_000, `Formatron cold compile took ${parsed.compileMs.toFixed(0)} ms.`);
    for (const entry of corpus) {
      assert.equal(parsed.results[entry.name], entry.expected, entry.name);
    }
  },
);
