import test from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';

import {
  buildScenarioRequestBody,
  getScenarioDefinitions,
  parseArgs,
  type DebugWebDecisionOptions,
} from '../scripts/debug-web-decision-thinking.ts';

function baseOptions(): DebugWebDecisionOptions {
  return {
    baseUrl: 'http://127.0.0.1:8097',
    model: 'model.gguf',
    prompt: 'What do you know about osrs iron bars?',
    mode: 'both',
    timeoutMs: 600000,
    maxTokens: 512,
    logFile: '',
    configPath: '',
  };
}

test('parseArgs accepts explicit debug web decision options', () => {
  const options = parseArgs([
    '--base-url', 'http://127.0.0.1:8080',
    '--model', 'qwen.gguf',
    '--prompt', 'hello',
    '--mode', 'thinking-off',
    '--timeout-ms', '1234',
    '--max-tokens', '64',
    '--log-file', '.siftkit/debug-web-decision/out.jsonl',
    '--config', '.siftkit/config.json',
  ], {
    cwd: 'C:\\repo',
    env: {},
    config: {},
  });

  assert.deepEqual(options, {
    baseUrl: 'http://127.0.0.1:8080',
    model: 'qwen.gguf',
    prompt: 'hello',
    mode: 'thinking-off',
    timeoutMs: 1234,
    maxTokens: 64,
    logFile: '.siftkit/debug-web-decision/out.jsonl',
    configPath: path.resolve('C:\\repo', '.siftkit/config.json'),
  });
});

test('parseArgs accepts matrix mode', () => {
  const options = parseArgs(['--mode', 'matrix'], {
    cwd: 'C:\\repo',
    env: {},
    config: {},
  });

  assert.equal(options.mode, 'matrix');
});

test('parseArgs reads runtime llama defaults from config when omitted', () => {
  const options = parseArgs([], {
    config: {
      Runtime: {
        Model: 'configured.gguf',
        LlamaCpp: { BaseUrl: 'http://127.0.0.1:8123' },
      },
    },
    cwd: 'C:\\repo',
    env: { SIFTKIT_CONFIG_PATH: 'runtime-config.json' },
  });

  assert.equal(options.baseUrl, 'http://127.0.0.1:8123');
  assert.equal(options.model, 'configured.gguf');
  assert.equal(options.configPath, path.resolve('C:\\repo', 'runtime-config.json'));
});

test('buildScenarioRequestBody matches web decision request shape for thinking variants', () => {
  const scenarios = getScenarioDefinitions('matrix');
  const thinkingOffScenario = scenarios.find((scenario) => scenario.name === 'thinking-off');
  const thinkingOffExplicitScenario = scenarios.find((scenario) => scenario.name === 'thinking-off-explicit');
  const thinkingOnBasicScenario = scenarios.find((scenario) => scenario.name === 'thinking-on-basic');
  const thinkingOnFullScenario = scenarios.find((scenario) => scenario.name === 'thinking-on-full');
  assert.ok(thinkingOffScenario);
  assert.ok(thinkingOffExplicitScenario);
  assert.ok(thinkingOnBasicScenario);
  assert.ok(thinkingOnFullScenario);
  const thinkingOff = buildScenarioRequestBody(baseOptions(), thinkingOffScenario);
  const thinkingOffExplicit = buildScenarioRequestBody(baseOptions(), thinkingOffExplicitScenario);
  const thinkingOnBasic = buildScenarioRequestBody(baseOptions(), thinkingOnBasicScenario);
  const thinkingOnFull = buildScenarioRequestBody(baseOptions(), thinkingOnFullScenario);

  assert.equal(thinkingOnBasic.stream, true);
  assert.equal(thinkingOnBasic.cache_prompt, true);
  assert.deepEqual(thinkingOnBasic.chat_template_kwargs, { enable_thinking: true });
  assert.equal(Object.prototype.hasOwnProperty.call(thinkingOff, 'chat_template_kwargs'), false);
  assert.deepEqual(thinkingOffExplicit.chat_template_kwargs, { enable_thinking: false });
  assert.deepEqual(thinkingOnFull.chat_template_kwargs, {
    enable_thinking: true,
    reasoning_content: true,
    preserve_thinking: true,
  });
  assert.match(String((thinkingOnBasic.messages as Array<Record<string, string>>)[0].content), /Decide the single next step/u);
  assert.equal((thinkingOnBasic.messages as Array<Record<string, string>>)[1].content, baseOptions().prompt);
});
