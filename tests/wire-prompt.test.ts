import assert from 'node:assert/strict';
import test from 'node:test';

import type { LlamaCppToolDefinition } from '../src/llm-protocol/types.js';
import type { ChatMessage } from '../src/repo-search/planner-protocol.js';
import { renderWirePrompt, WIRE_GENERATION_PROMPT } from '../src/repo-search/wire-prompt.js';

// ChatML role markers. Built from a code-point concatenation so the token
// sequence does not appear verbatim in sources or diffs.
const IM_START = String.fromCodePoint(0x3c, 0x7c, 0x69, 0x6d, 0x5f, 0x73, 0x74, 0x61, 0x72, 0x74, 0x7c, 0x3e);
const IM_END = String.fromCodePoint(0x3c, 0x7c, 0x69, 0x6d, 0x5f, 0x65, 0x6e, 0x64, 0x7c, 0x3e);
const block = (role: string, body: string): string => `${IM_START}${role}\n${body}${IM_END}\n`;

test('renders each message as a ChatML block and appends the generation prompt', () => {
  const rendered = renderWirePrompt({
    messages: [
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'HELLO' },
    ],
    tools: [],
    responseFormat: null,
    includeReasoningContent: false,
  });

  assert.equal(
    rendered,
    block('system', 'SYS')
    + block('user', 'HELLO')
    + WIRE_GENERATION_PROMPT,
  );
});

test('places tool schemas in the leading block', () => {
  const tools: LlamaCppToolDefinition[] = [{ type: 'function', function: { name: 'grep', description: 'search', parameters: { type: 'object' } } }];
  const rendered = renderWirePrompt({
    messages: [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'HI' }],
    tools,
    responseFormat: null,
    includeReasoningContent: false,
  });

  assert.ok(rendered.startsWith(block('system', `SYS\n${JSON.stringify(tools)}`)));
  assert.ok(rendered.includes('"grep"'));
});

test('emits a standalone leading block when tools exist but messages do not', () => {
  const tools: LlamaCppToolDefinition[] = [{ type: 'function', function: { name: 'grep', description: 'search', parameters: { type: 'object' } } }];
  const rendered = renderWirePrompt({ messages: [], tools, responseFormat: null, includeReasoningContent: false });

  assert.equal(rendered, block('system', JSON.stringify(tools)) + WIRE_GENERATION_PROMPT);
});

test('renders tool_calls in wire shape, not transcript shape', () => {
  const rendered = renderWirePrompt({
    messages: [
      {
        role: 'assistant',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'grep', arguments: '{"q":"x"}' } }],
      },
      { role: 'tool', content: 'RESULT', tool_call_id: 'call_1' },
    ],
    tools: [],
    responseFormat: null,
    includeReasoningContent: false,
  });

  assert.ok(rendered.includes('"tool_call_id":"call_1"'));
  assert.ok(!rendered.includes('tool_call_id=call_1'));
  assert.ok(rendered.includes('"name":"grep"'));
});

test('includes reasoning_content only when enabled, and never as a [reasoning] section', () => {
  const messages: ChatMessage[] = [{ role: 'assistant', content: 'ANSWER', reasoning_content: 'THINKING' }];

  const on = renderWirePrompt({ messages, tools: [], responseFormat: null, includeReasoningContent: true });
  const off = renderWirePrompt({ messages, tools: [], responseFormat: null, includeReasoningContent: false });

  assert.ok(on.includes('THINKING'));
  assert.ok(!on.includes('[reasoning]'));
  assert.ok(!off.includes('THINKING'));
});

test('drops image parts and concatenates text parts', () => {
  const rendered = renderWirePrompt({
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'ALPHA' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        { type: 'text', text: 'BETA' },
      ],
    }],
    tools: [],
    responseFormat: null,
    includeReasoningContent: false,
  });

  assert.equal(rendered, block('user', 'ALPHABETA') + WIRE_GENERATION_PROMPT);
});

test('appending a message keeps the previous rendering as a prefix', () => {
  const base: ChatMessage[] = [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'ONE' }];
  const grown: ChatMessage[] = [...base, { role: 'assistant', content: 'TWO' }];
  const options = { tools: [], responseFormat: null, includeReasoningContent: false };

  const first = renderWirePrompt({ messages: base, ...options });
  const second = renderWirePrompt({ messages: grown, ...options });

  assert.ok(second.startsWith(first.slice(0, first.length - WIRE_GENERATION_PROMPT.length)));
});