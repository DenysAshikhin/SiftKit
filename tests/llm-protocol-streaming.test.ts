import test from 'node:test';
import assert from 'node:assert/strict';

import { LlamaCppStreamingResponseAssembler } from '../src/llm-protocol/streaming-response-assembler.js';

test('streaming assembler accumulates content, reasoning, and tool-call deltas', () => {
  const assembler = new LlamaCppStreamingResponseAssembler(['repo_rg']);

  assembler.ingestChoiceDelta({ delta: { reasoning_content: 'think ', content: 'ans' } });
  assembler.ingestChoiceDelta({
    delta: {
      tool_calls: [{ index: 0, id: 'call_1', function: { name: 'repo_rg', arguments: '{"pattern":' } }],
    },
  });
  assembler.ingestChoiceDelta({
    delta: {
      tool_calls: [{ index: 0, function: { arguments: '"x"}' } }],
    },
  });

  const response = assembler.toResponse({
    promptTokens: 1,
    completionTokens: 2,
    outputTokens: 2,
    thinkingTokens: 1,
    promptCacheTokens: null,
    promptEvalTokens: 1,
  });

  assert.equal(response.text, 'ans');
  assert.equal(response.reasoningText, 'think ');
  assert.equal(response.toolCalls[0]?.function.arguments, '{"pattern":"x"}');
});

test('streaming assembler early-stops runaway structural repetition', () => {
  const assembler = new LlamaCppStreamingResponseAssembler(['finish'], { structuralRepeatLimit: 4 });

  for (const chunk of ['||||', '||||', '||||', '||||']) {
    assembler.ingestChoiceDelta({ delta: { content: chunk } });
  }

  const response = assembler.toResponse({
    promptTokens: null,
    completionTokens: null,
    outputTokens: null,
    thinkingTokens: null,
    promptCacheTokens: null,
    promptEvalTokens: null,
  });

  assert.equal(response.stoppedEarly, true);
  assert.match(response.earlyStopReason || '', /runaway/i);
});
