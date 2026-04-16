// @ts-nocheck — Split from runtime.test.js. Full TS typing deferred.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  loadConfig,
  getChunkThresholdCharacters,
} = require('../dist/config/index.js');
const { summarizeRequest } = require('../dist/summary.js');
const {
  buildOversizedTransitionsInput,
  getPlannerLogsPath,
  withTempEnv,
  withStubServer,
} = require('./_runtime-helpers.js');

test('planner writes a debug dump with input, thinking, tool calls, tool output, and final output', async () => {
  await withTempEnv(async () => {
    const plannerLogsPath = getPlannerLogsPath();
    fs.mkdirSync(plannerLogsPath, { recursive: true });
    const before = new Set(fs.readdirSync(plannerLogsPath).filter((entry) => /^planner_debug_.*\.json$/u.test(entry)));

    await withStubServer(async () => {
      const config = await loadConfig({ ensure: true });
      const threshold = getChunkThresholdCharacters(config);
      const inputText = buildOversizedTransitionsInput(threshold + 1000);

      const result = await summarizeRequest({
        question: 'Find all transitions in the Lumbridge Castle area.',
        inputText,
        format: 'text',
        policyProfile: 'general',
        backend: 'llama.cpp',
        model: 'mock-model',
        debugCommand: 'cat transitions.json | siftkit "Find all transitions in the Lumbridge Castle area."',
      });

      assert.equal(result.Classification, 'summary');
    }, {
      assistantReasoningContent(promptText, parsed, requestIndex) {
        return requestIndex === 1
          ? 'I should use json_filter to isolate Lumbridge Castle transitions.'
          : 'I have enough evidence to answer now.';
      },
      assistantContent(promptText, parsed, requestIndex) {
        if (requestIndex === 1) {
          return JSON.stringify({
            action: 'tool',
            tool_name: 'json_filter',
            args: {
              filters: [
                { path: 'from.worldX', op: 'gte', value: 3200 },
                { path: 'from.worldX', op: 'lte', value: 3215 },
              ],
              select: ['id', 'label', 'from', 'to', 'bidirectional'],
              limit: 20,
            },
          });
        }

        return JSON.stringify({
          action: 'finish',
          classification: 'summary',
          raw_review_required: false,
          output: 'debug dump summary',
        });
      },
    });

    const after = fs.readdirSync(plannerLogsPath).filter((entry) => /^planner_debug_.*\.json$/u.test(entry));
    const added = after.filter((entry) => !before.has(entry));
    assert.equal(added.length, 1);

    const debugDump = JSON.parse(fs.readFileSync(path.join(plannerLogsPath, added[0]), 'utf8'));
    assert.equal(debugDump.command, 'cat transitions.json | siftkit "Find all transitions in the Lumbridge Castle area."');
    assert.equal(typeof debugDump.inputText, 'string');
    assert.match(debugDump.inputText, /Lumbridge Castle Staircase/u);
    assert.equal(Array.isArray(debugDump.events), true);
    assert.equal(debugDump.events.some((event) => event.kind === 'planner_model_response' && /json_filter/u.test(String(event.thinkingProcess || ''))), true);
    assert.equal(debugDump.events.some((event) => event.kind === 'planner_tool' && event.command === 'json_filter {"filters":[{"path":"from.worldX","op":"gte","value":3200},{"path":"from.worldX","op":"lte","value":3215}],"select":["id","label","from","to","bidirectional"],"limit":20}'), true);
    assert.equal(debugDump.events.some((event) => event.kind === 'planner_tool' && typeof event.output?.text === 'string' && /Lumbridge Castle Staircase/u.test(event.output.text)), true);
    assert.equal(debugDump.final.finalOutput, 'debug dump summary');
  });
});
