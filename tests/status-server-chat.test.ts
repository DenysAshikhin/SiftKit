import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import {
  appendChatMessagesWithUsage,
  buildChatCompletionRequest,
  buildChatSystemContent,
  buildContextUsage,
  buildRepoSearchMarkdown,
  buildPersistTurnsFromRepoSearchResult,
  streamChatAssistantMessage,
  streamDirectChatWebTurn,
  WEB_CHAT_ANSWER_PROMPT,
  WEB_CHAT_DECISION_PROMPT,
} from '../src/status-server/chat.ts';
import type { WebStreamProgress } from '../src/status-server/chat.ts';
import { getWebSearchOverride, resolveEffectiveWebSearchEnabled } from '../src/status-server/routes/chat.ts';
import { WebResearchTools } from '../src/web-search/web-research-tools.ts';
import type { WebSearchConfig } from '../src/web-search/types.ts';
import { buildChatPromptContext } from '../src/status-server/chat-prompt-context.ts';
import { estimatePromptTokenCountFromCharacters, getDynamicMaxOutputTokens } from '../src/lib/dynamic-output-cap.js';
import { estimateTokenCount, type ChatSession } from '../src/state/chat-sessions.ts';
import type { Dict } from '../src/lib/types.ts';

function createConfig(overrides: Partial<Dict> = {}): Dict {
  return {
    Runtime: {
      Model: 'managed.gguf',
      LlamaCpp: {
        BaseUrl: 'http://127.0.0.1:8080',
        NumCtx: 8192,
        Temperature: 0.7,
        TopP: 0.9,
        TopK: 40,
        MinP: 0.05,
        PresencePenalty: 0,
        RepetitionPenalty: 1.1,
        MaxTokens: 512,
        Reasoning: 'on',
      },
    },
    Server: {
      LlamaCpp: {
        BaseUrl: 'http://127.0.0.1:8080',
        Reasoning: 'on',
        ReasoningContent: true,
        PreserveThinking: true,
      },
    },
    ...overrides,
  } as Dict;
}

function createSession(): ChatSession {
  return {
    id: 'session-1',
    title: 'Session',
    model: 'managed.gguf',
    contextWindowTokens: 8192,
    thinkingEnabled: true,
    createdAtUtc: '2026-04-17T00:00:00.000Z',
    updatedAtUtc: '2026-04-17T00:00:00.000Z',
    messages: [
      {
        id: 'assistant-1',
        role: 'assistant',
        content: 'final answer',
        thinkingContent: 'prior thinking',
      },
      {
        id: 'assistant-2',
        role: 'assistant',
        content: 'answer without thinking',
        thinkingContent: '',
      },
    ],
  } as ChatSession;
}

const WEB_CONFIG: WebSearchConfig = {
  EnabledDefault: false,
  Provider: 'searxng',
  SearxngBaseUrl: 'https://search.example.test',
  ResultCount: 3,
  FetchMaxPages: 3,
  TimeoutMs: 15000,
  FetchMaxCharacters: 12000,
};

function searxngWebTools(): WebResearchTools {
  return new WebResearchTools(WEB_CONFIG, async () => new Response(JSON.stringify({
    results: [{ title: 'Example', url: 'https://example.com', content: 'snippet' }],
  }), { status: 200, headers: { 'content-type': 'application/json' } }));
}

test('getWebSearchOverride normalizes override values', () => {
  assert.equal(getWebSearchOverride('on'), 'on');
  assert.equal(getWebSearchOverride('off'), 'off');
  assert.equal(getWebSearchOverride('default'), 'default');
  assert.equal(getWebSearchOverride('garbage'), 'default');
  assert.equal(getWebSearchOverride(undefined), 'default');
});

test('resolveEffectiveWebSearchEnabled applies the override gate', () => {
  assert.equal(resolveEffectiveWebSearchEnabled(false, 'default'), false);
  assert.equal(resolveEffectiveWebSearchEnabled(true, 'default'), true);
  assert.equal(resolveEffectiveWebSearchEnabled(false, 'on'), true);
  assert.equal(resolveEffectiveWebSearchEnabled(true, 'off'), false);
});

test('streamChatAssistantMessage forwards webActionInstruction and evidenceMessages into the request', async () => {
  let capturedBody = '';
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      capturedBody = body;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'thinking-live' } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'streamed answer' } }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  const config = createConfig();
  (config.Server as Dict).LlamaCpp = {
    ...((config.Server as Dict).LlamaCpp as Dict),
    BaseUrl: `http://127.0.0.1:${port}`,
  };
  try {
    const progress: Array<{ thinking: string; answer: string }> = [];
    const result = await streamChatAssistantMessage(config, createSession(), 'q', (p) => {
      progress.push({ thinking: p.thinkingContent, answer: p.assistantContent });
    }, {
      webActionInstruction: 'WEB-DECISION-MARKER web_search web_fetch',
      evidenceMessages: [{ role: 'user', content: 'EVIDENCE-MARKER tool output' }],
    });
    assert.equal(result.assistantContent, 'streamed answer');
    assert.equal(result.thinkingContent, 'thinking-live');
    assert.ok(progress.length >= 1);
    const parsed = JSON.parse(capturedBody) as Dict;
    const messages = parsed.messages as Dict[];
    const systemMessage = messages.find((message) => message.role === 'system');
    assert.match(String(systemMessage?.content), /WEB-DECISION-MARKER/);
    assert.ok(messages.some((message) => String(message.content).includes('EVIDENCE-MARKER')));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('streamChatAssistantMessage accepts upstream reset after DONE when answer completed', async () => {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'complete answer' } }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      setImmediate(() => res.socket?.destroy(new Error('simulated post-DONE reset')));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  const config = createConfig();
  (config.Server as Dict).LlamaCpp = {
    ...((config.Server as Dict).LlamaCpp as Dict),
    BaseUrl: `http://127.0.0.1:${port}`,
  };
  try {
    const result = await streamChatAssistantMessage(config, createSession(), 'q', null);

    assert.equal(result.assistantContent, 'complete answer');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('WEB_CHAT_DECISION_PROMPT documents the decision actions and fluctuating-data policy', () => {
  assert.match(WEB_CHAT_DECISION_PROMPT, /web_search/);
  assert.match(WEB_CHAT_DECISION_PROMPT, /web_fetch/);
  assert.match(WEB_CHAT_DECISION_PROMPT, /"action":"answer"/);
  assert.match(WEB_CHAT_DECISION_PROMPT, /price|fluctuat|exchange rate|version/i);
});

test('WEB_CHAT_ANSWER_PROMPT instructs prose answer grounded in evidence', () => {
  assert.match(WEB_CHAT_ANSWER_PROMPT, /prose|markdown/i);
  assert.match(WEB_CHAT_ANSWER_PROMPT, /evidence|source/i);
});

test('streamDirectChatWebTurn streams a web_search tool then a prose answer', async () => {
  const events: WebStreamProgress[] = [];
  const result = await streamDirectChatWebTurn(createConfig(), createSession(), 'find latest', searxngWebTools(), (event) => events.push(event), {
    mockResponses: [
      '{"action":"web_search","query":"osrs iron bar"}',
      '{"action":"answer"}',
      'Iron bars are refined iron, made by smelting iron ore.',
    ],
  });

  assert.equal(result.assistantContent, 'Iron bars are refined iron, made by smelting iron ore.');
  const toolTurns = result.turns.filter((turn) => turn.toolMessages.length > 0);
  assert.equal(toolTurns.length, 1);
  assert.equal(toolTurns[0].toolMessages[0].toolCallCommand, 'web_search query="osrs iron bar"');
  assert.equal(toolTurns[0].toolMessages[0].toolCallExitCode, 0);
  assert.match(toolTurns[0].toolMessages[0].toolCallOutput, /example\.com/);
  assert.ok(events.some((event) => event.kind === 'tool_start' && event.command === 'web_search query="osrs iron bar"'));
  assert.ok(events.some((event) => event.kind === 'tool_result' && event.exitCode === 0));
  assert.ok(events.some((event) => event.kind === 'answer' && event.answer.includes('refined iron')));
});

test('streamDirectChatWebTurn answers directly when no web tool is needed', async () => {
  const events: WebStreamProgress[] = [];
  const result = await streamDirectChatWebTurn(createConfig(), createSession(), 'static q', searxngWebTools(), (event) => events.push(event), {
    mockResponses: ['{"action":"answer"}', 'Static answer.'],
  });

  assert.equal(result.assistantContent, 'Static answer.');
  assert.equal(result.turns.filter((turn) => turn.toolMessages.length > 0).length, 0);
  assert.ok(!events.some((event) => event.kind === 'tool_start'));
});

test('streamDirectChatWebTurn falls back to a streamed answer on unparseable decision (no error string)', async () => {
  const result = await streamDirectChatWebTurn(createConfig(), createSession(), 'q', searxngWebTools(), () => {}, {
    mockResponses: ['this is not a json action at all', 'The real prose answer survives.'],
  });

  assert.equal(result.assistantContent, 'The real prose answer survives.');
  assert.doesNotMatch(result.assistantContent, /could not be completed/i);
});

test('streamDirectChatWebTurn forces an answer turn when the tool budget is exhausted', async () => {
  const result = await streamDirectChatWebTurn(createConfig(), createSession(), 'q', searxngWebTools(), () => {}, {
    maxTurns: 1,
    mockResponses: [
      '{"action":"web_search","query":"a"}',
      '{"action":"web_search","query":"b"}',
      'Answer after hitting the limit.',
    ],
  });

  assert.equal(result.assistantContent, 'Answer after hitting the limit.');
  assert.equal(result.turns.filter((turn) => turn.toolMessages.length > 0).length, 1);
});

test('streamDirectChatWebTurn records a failed tool bubble and continues to answer', async () => {
  const events: WebStreamProgress[] = [];
  const result = await streamDirectChatWebTurn(createConfig(), createSession(), 'q', searxngWebTools(), (event) => events.push(event), {
    mockResponses: [
      '{"action":"web_fetch","url":"http://127.0.0.1:9"}',
      '{"action":"answer"}',
      'Recovered answer.',
    ],
  });

  assert.equal(result.assistantContent, 'Recovered answer.');
  const toolTurns = result.turns.filter((turn) => turn.toolMessages.length > 0);
  assert.equal(toolTurns.length, 1);
  assert.notEqual(toolTurns[0].toolMessages[0].toolCallExitCode, 0);
  assert.ok(events.some((event) => event.kind === 'tool_result' && event.exitCode !== 0));
});

test('buildChatSystemContent appends the web action instruction when provided', () => {
  const content = buildChatSystemContent(createConfig(), createSession(), { webActionInstruction: WEB_CHAT_DECISION_PROMPT });
  assert.match(content, /web_search/);
});

test('buildChatCompletionRequest replays assistant reasoning_content only when enabled and present', () => {
  const request = buildChatCompletionRequest(createConfig(), createSession(), 'next question');
  const messages = request.body.messages as Array<Record<string, unknown>>;
  const assistantMessages = messages.filter((message) => message.role === 'assistant');

  assert.deepEqual(request.body.chat_template_kwargs, {
    enable_thinking: true,
    reasoning_content: true,
    preserve_thinking: true,
  });
  assert.deepEqual(assistantMessages[0], {
    role: 'assistant',
    content: 'final answer',
    reasoning_content: 'prior thinking',
  });
  assert.deepEqual(assistantMessages[1], {
    role: 'assistant',
    content: 'answer without thinking',
  });
});

test('buildChatCompletionRequest replays typed timeline bubbles as prompt messages', () => {
  const session = createSession();
  session.messages = [
    {
      id: 'user-typed',
      role: 'user',
      kind: 'user_text',
      content: 'Find chat timeline code.',
    },
    {
      id: 'thinking-typed',
      role: 'assistant',
      kind: 'assistant_thinking',
      content: 'I should inspect the dashboard chat component.',
    },
    {
      id: 'tool-typed',
      role: 'assistant',
      kind: 'assistant_tool_call',
      content: 'rg -n "ChatTab" dashboard/src',
      toolCallCommand: 'rg -n "ChatTab" dashboard/src',
      toolCallOutput: 'dashboard/src/tabs/ChatTab.tsx:75:export function ChatTab',
    },
    {
      id: 'answer-typed',
      role: 'assistant',
      kind: 'assistant_answer',
      content: 'ChatTab renders the chat surface.',
    },
  ];

  const request = buildChatCompletionRequest(createConfig(), session, 'next question');
  const messages = request.body.messages as Array<Record<string, unknown>>;

  assert.deepEqual(messages.slice(1), [
    { role: 'user', content: 'Find chat timeline code.' },
    { role: 'assistant', content: 'I should inspect the dashboard chat component.' },
    {
      role: 'assistant',
      content: 'Tool call: rg -n "ChatTab" dashboard/src\n\nResult:\ndashboard/src/tabs/ChatTab.tsx:75:export function ChatTab',
    },
    { role: 'assistant', content: 'ChatTab renders the chat surface.' },
    { role: 'user', content: 'next question' },
  ]);
});

test('appendChatMessagesWithUsage persists interleaved per-turn thinking and tools', () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-chat-turns-'));
  const session = appendChatMessagesWithUsage(
    runtimeRoot,
    createSession(),
    'Find tool call handling.',
    'Tool calls are handled in engine.ts.',
    { promptTokens: 30, completionTokens: 9, thinkingTokens: 0, promptCacheTokens: null, promptEvalTokens: 30 },
    {
      turns: [
        { thinkingText: 'think one', toolMessages: [{
          id: 'tool-a', content: 'rg -n "a" src', toolCallCommand: 'rg -n "a" src',
          toolCallTurn: 1, toolCallMaxTurns: 2, toolCallExitCode: 0,
          toolCallOutputSnippet: 'snippet', toolCallOutput: 'x'.repeat(10_000), outputTokens: 295,
        }] },
        { thinkingText: 'final think', toolMessages: [] },
      ],
    }
  );

  const appended = session.messages.slice(2).map((m) => m.kind);
  assert.deepEqual(appended, [
    'user_text',
    'assistant_thinking',
    'assistant_tool_call',
    'assistant_thinking',
    'assistant_answer',
  ]);
  const toolMessage = session.messages.find((m) => m.kind === 'assistant_tool_call');
  assert.equal(toolMessage?.outputTokensEstimate, 295);
  assert.equal(toolMessage?.associatedToolTokens, 295);
});

test('appendChatMessagesWithUsage aligns hidden tool contexts with persisted tool message ids', () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-chat-hidden-'));
  const session = appendChatMessagesWithUsage(
    runtimeRoot, createSession(), 'q', 'answer',
    { promptTokens: 10, completionTokens: 5, thinkingTokens: 0, promptCacheTokens: null, promptEvalTokens: 10 },
    {
      toolContextContents: ['context for a', 'context for b'],
      turns: [
        { thinkingText: '', toolMessages: [
          { id: 'tool-a', content: 'rg a', toolCallCommand: 'rg a', toolCallTurn: 1, toolCallMaxTurns: 2, toolCallExitCode: 0, toolCallOutputSnippet: 'a', toolCallOutput: 'a', outputTokens: 1 },
          { id: 'tool-b', content: 'rg b', toolCallCommand: 'rg b', toolCallTurn: 2, toolCallMaxTurns: 2, toolCallExitCode: 0, toolCallOutputSnippet: 'b', toolCallOutput: 'b', outputTokens: 1 },
        ] },
      ],
    }
  );
  const toolIds = session.messages.filter((m) => m.kind === 'assistant_tool_call').map((m) => m.id);
  const hidden = (session.hiddenToolContexts || []) as Array<{ content: string; sourceMessageId: string }>;
  assert.equal(hidden.length, 2);
  assert.equal(hidden[0].content, 'context for a');
  assert.equal(hidden[0].sourceMessageId, toolIds[0]);
  assert.equal(hidden[1].content, 'context for b');
  assert.equal(hidden[1].sourceMessageId, toolIds[1]);
});

test('appendChatMessagesWithUsage omits empty-thinking turns and persists single-turn chat', () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-chat-single-'));
  const session = appendChatMessagesWithUsage(
    runtimeRoot, createSession(), 'hi', 'hello',
    { promptTokens: 5, completionTokens: 2, thinkingTokens: 1, promptCacheTokens: null, promptEvalTokens: 5 },
    { turns: [{ thinkingText: 'regular chat reasoning', toolMessages: [] }] }
  );
  assert.deepEqual(session.messages.slice(2).map((m) => m.kind), ['user_text', 'assistant_thinking', 'assistant_answer']);

  const emptySession = appendChatMessagesWithUsage(
    runtimeRoot, createSession(), 'hi', 'hello', {},
    { turns: [{ thinkingText: '', toolMessages: [] }] }
  );
  assert.deepEqual(emptySession.messages.slice(2).map((m) => m.kind), ['user_text', 'assistant_answer']);
});

test('buildChatPromptContext exposes direct system prompt and hidden tool context', () => {
  const session = createSession();
  session.hiddenToolContexts = [{
    id: 'hidden-1',
    content: 'repo evidence that is still in prompt context',
    tokenEstimate: 11,
    sourceMessageId: 'tool-1',
  }];

  const context = buildChatPromptContext(createConfig(), session, {
    promptPrefix: 'custom system prompt',
  });

  assert.equal(context.kind, 'system_context');
  assert.equal(context.deletable, false);
  assert.match(context.content, /System prompt/u);
  assert.match(context.content, /custom system prompt/u);
  assert.match(context.content, /repo evidence that is still in prompt context/u);
  assert.equal(
    buildChatSystemContent(createConfig(), session, { promptPrefix: 'custom system prompt' }).includes('repo evidence that is still in prompt context'),
    true,
  );
});

test('buildChatPromptContext exposes repo-search tool schema', () => {
  const session = createSession();
  session.mode = 'repo-search';
  session.presetId = 'repo-search';
  session.planRepoRoot = process.cwd();

  const context = buildChatPromptContext(createConfig({
    Presets: [{
      id: 'repo-search',
      label: 'Repo Search',
      presetKind: 'repo-search',
      operationMode: 'read-only',
      allowedTools: ['repo_rg'],
      promptPrefix: 'extra repo instruction',
    }],
  }), session);

  assert.match(context.content, /System prompt/u);
  assert.match(context.content, /You are a repo-search planner/u);
  assert.match(context.content, /Preset prompt prefix/u);
  assert.match(context.content, /extra repo instruction/u);
  assert.match(context.content, /Tool schema/u);
  const toolSchemaSection = context.content.split('## Tool schema')[1] || '';
  assert.match(toolSchemaSection, /repo_rg/u);
  assert.doesNotMatch(toolSchemaSection, /repo_read_file/u);
});

test('buildRepoSearchMarkdown collapses exact repeated final output blocks for display', () => {
  const repeatedOutput = [
    '| Category | Concern |',
    '|---|---|',
    '| Bank | helper duplication |',
    '',
    'Note: exact evidence only.',
    '| Category | Concern |',
    '|---|---|',
    '| Bank | helper duplication |',
    '',
    'Note: exact evidence only.',
  ].join('\n');

  const markdown = buildRepoSearchMarkdown('audit duplicates', 'C:\\repo', {
    transcriptPath: 'transcript',
    artifactPath: 'artifact',
    scorecard: {
      tasks: [{ finalOutput: repeatedOutput }],
    },
  });

  assert.match(markdown, /\| Bank \| helper duplication \|/u);
  assert.equal(markdown.match(/\| Category \| Concern \|/gu)?.length, 1);
});

test('buildChatCompletionRequest omits thinking preservation flags when direct chat thinking is toggled off', () => {
  const session = createSession();
  session.thinkingEnabled = false;

  const request = buildChatCompletionRequest(createConfig(), session, 'next question', {
    thinkingEnabled: session.thinkingEnabled !== false,
  });

  assert.deepEqual(request.body.chat_template_kwargs, {
    enable_thinking: false,
  });
  assert.equal('extra_body' in request.body, false);
});

test('buildChatCompletionRequest uses dynamic max_tokens from remaining context', () => {
  const request = buildChatCompletionRequest(createConfig(), createSession(), 'next question');
  const promptChars = ((request.body.messages as Array<Record<string, unknown>>) || [])
    .reduce((total, message) => total + String(message.content || '').length, 0);

  assert.equal(
    request.body.max_tokens,
    getDynamicMaxOutputTokens({
      totalContextTokens: 8192,
      promptTokenCount: estimatePromptTokenCountFromCharacters(createConfig(), promptChars),
    })
  );
});

test('buildContextUsage estimates continuation context from session content instead of provider prompt telemetry', () => {
  const session = {
    id: 'session-usage',
    contextWindowTokens: 75000,
    messages: [
      {
        id: 'user-1',
        role: 'user',
        content: 'How are tool calls handled?',
        inputTokensEstimate: 52403,
        inputTokensEstimated: false,
      },
      {
        id: 'assistant-1',
        role: 'assistant',
        content: '# Repo Search Results\n\nTool calls are parsed and executed through the loop.',
        outputTokensEstimate: 2288,
        outputTokensEstimated: true,
        thinkingTokens: 3405,
        thinkingTokensEstimated: true,
        thinkingContent: 'Prior reasoning that can be replayed.',
      },
    ],
    hiddenToolContexts: [
      {
        content: 'tool transcript content',
        tokenEstimate: 5708,
      },
    ],
  } as ChatSession;

  const expectedThinkingTokens = estimateTokenCount('Prior reasoning that can be replayed.');
  const expectedChatTokens = estimateTokenCount('general, coder friendly assistant')
    + estimateTokenCount('How are tool calls handled?')
    + estimateTokenCount('# Repo Search Results\n\nTool calls are parsed and executed through the loop.')
    + expectedThinkingTokens;
  const expectedToolTokens = estimateTokenCount(
    'Internal tool-call context from prior session steps. Use this as additional evidence only when relevant.',
  ) + 5708;
  const usage = buildContextUsage(session);

  assert.equal(usage.chatUsedTokens, expectedChatTokens);
  assert.equal(usage.usedTokens, expectedChatTokens);
  assert.equal(usage.thinkingUsedTokens, expectedThinkingTokens);
  assert.equal(usage.toolUsedTokens, expectedToolTokens);
  assert.equal(usage.totalUsedTokens, expectedChatTokens + expectedToolTokens);
  assert.equal(usage.estimatedTokenFallbackTokens, 0);
});

test('buildPersistTurnsFromRepoSearchResult interleaves per-turn thinking before that turn\'s tools', () => {
  const turns = buildPersistTurnsFromRepoSearchResult({
    scorecard: {
      tasks: [{
        turnThinking: { 1: 'think one', 2: 'think two', 3: 'final think' },
        commands: [
          { command: 'rg -n "a" src --no-ignore', modelVisibleCommand: 'rg -n "a" src', turn: 1, exitCode: 0, output: 'a', promptOutput: 'a', outputTokens: 3 },
          { command: 'rg -n "b" src --no-ignore', modelVisibleCommand: 'rg -n "b" src', turn: 2, exitCode: 0, output: 'b', promptOutput: 'b', outputTokens: 4 },
        ],
      }],
    },
  });

  assert.equal(turns.length, 3);
  assert.equal(turns[0].thinkingText, 'think one');
  assert.equal(turns[0].toolMessages.length, 1);
  assert.equal(turns[0].toolMessages[0].toolCallCommand, 'rg -n "a" src');
  assert.equal(turns[0].toolMessages[0].toolCallTurn, 1);
  assert.equal(turns[1].thinkingText, 'think two');
  assert.equal(turns[1].toolMessages[0].toolCallCommand, 'rg -n "b" src');
  assert.equal(turns[2].thinkingText, 'final think');
  assert.equal(turns[2].toolMessages.length, 0);
});

test('buildPersistTurnsFromRepoSearchResult uses prompt output and tokens for tool bubbles', () => {
  const turns = buildPersistTurnsFromRepoSearchResult({
    scorecard: {
      tasks: [{
        turnThinking: {},
        commands: [{
          command: 'rg -n "tool_call" src --no-ignore',
          modelVisibleCommand: 'rg -n "tool_call" src',
          turn: 1, exitCode: 0,
          output: 'x'.repeat(10_000),
          promptOutput: 'src/repo-search/engine.ts:1613:tool_result',
          outputTokens: 295,
        }],
      }],
    },
  });
  const message = turns[0].toolMessages[0];
  assert.equal(message.toolCallOutput, 'src/repo-search/engine.ts:1613:tool_result');
  assert.equal(message.toolCallOutputSnippet, 'src/repo-search/engine.ts:1613:tool_result');
  assert.equal(message.outputTokens, 295);
});

test('buildPersistTurnsFromRepoSearchResult emits no thinking bubble for a tools-only turn', () => {
  const turns = buildPersistTurnsFromRepoSearchResult({
    scorecard: { tasks: [{
      turnsUsed: 1,
      turnThinking: {},
      commands: [{ command: 'rg -n "x" src', modelVisibleCommand: 'rg -n "x" src', turn: 1, exitCode: 0, output: 'x' }],
    }] },
  });
  assert.equal(turns.length, 1);
  assert.equal(turns[0].thinkingText, '');
  assert.equal(turns[0].toolMessages.length, 1);
});

test('buildPersistTurnsFromRepoSearchResult sets tool maxTurns from task turnsUsed', () => {
  const turns = buildPersistTurnsFromRepoSearchResult({
    scorecard: { tasks: [{
      turnsUsed: 4,
      turnThinking: {},
      commands: [{ command: 'rg -n "x" src', modelVisibleCommand: 'rg -n "x" src', turn: 2, exitCode: 0, output: 'x' }],
    }] },
  });
  assert.equal(turns[0].toolMessages[0].toolCallTurn, 2);
  assert.equal(turns[0].toolMessages[0].toolCallMaxTurns, 4);
});

test('buildPersistTurnsFromRepoSearchResult throws on a command with a missing turn', () => {
  assert.throws(() => buildPersistTurnsFromRepoSearchResult({
    scorecard: { tasks: [{
      turnsUsed: 1,
      turnThinking: {},
      commands: [{ command: 'rg -n "x" src', modelVisibleCommand: 'rg -n "x" src', exitCode: 0, output: 'x' }],
    }] },
  }), /invalid turn/u);
});

test('persisted planner turns replay 1:1 into the model request and are deterministic', () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-chat-replay-'));
  const base = createSession();
  base.messages = [];
  const session = appendChatMessagesWithUsage(
    runtimeRoot,
    base,
    'find the answer',
    'final markdown answer',
    { promptTokens: 10, completionTokens: 5, thinkingTokens: 2, promptCacheTokens: null, promptEvalTokens: 10 },
    {
      turns: [
        { thinkingText: 'turn one reasoning', toolMessages: [{
          id: 'tool-x', content: 'rg -n "x" src', toolCallCommand: 'rg -n "x" src',
          toolCallTurn: 1, toolCallMaxTurns: 1, toolCallExitCode: 0,
          toolCallOutputSnippet: 'hit', toolCallOutput: 'hit', outputTokens: 2,
        }] },
        { thinkingText: 'final reasoning', toolMessages: [] },
      ],
    }
  );

  const request = buildChatCompletionRequest(createConfig(), session, 'next question');
  const messages = request.body.messages as Array<Record<string, unknown>>;
  const assistantTexts = messages.filter((m) => m.role === 'assistant').map((m) => m.content);
  assert.deepEqual(assistantTexts, [
    'turn one reasoning',
    'Tool call: rg -n "x" src\n\nResult:\nhit',
    'final reasoning',
    'final markdown answer',
  ]);

  // Determinism: identical session yields identical request (prompt-caching safe).
  const again = buildChatCompletionRequest(createConfig(), session, 'next question');
  assert.deepEqual(again.body.messages, request.body.messages);
});

test('repo-search result persists and replays 1:1 through the builder', () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-chat-e2e-'));
  const base = createSession();
  base.messages = [];
  const result = {
    requestId: 'run-1',
    scorecard: { tasks: [{
      turnsUsed: 2,
      turnThinking: { 1: 'reason about a', 2: 'final reason' },
      commands: [
        { command: 'rg -n "a" src --no-ignore', modelVisibleCommand: 'rg -n "a" src', turn: 1, exitCode: 0, output: 'a', promptOutput: 'a', outputTokens: 2 },
      ],
    }] },
  };
  const session = appendChatMessagesWithUsage(
    runtimeRoot, base, 'find a', 'final markdown',
    { promptTokens: 10, completionTokens: 5, thinkingTokens: 2, promptCacheTokens: null, promptEvalTokens: 10 },
    { turns: buildPersistTurnsFromRepoSearchResult(result), toolContextContents: [] }
  );
  const request = buildChatCompletionRequest(createConfig(), session, 'next');
  const assistantTexts = (request.body.messages as Array<Record<string, unknown>>)
    .filter((m) => m.role === 'assistant').map((m) => m.content);
  assert.deepEqual(assistantTexts, [
    'reason about a',
    'Tool call: rg -n "a" src\n\nResult:\na',
    'final reason',
    'final markdown',
  ]);
});

test('buildContextUsage counts typed thinking and tool bubbles from visible timeline content', () => {
  const session = {
    id: 'session-usage-typed',
    contextWindowTokens: 75000,
    messages: [
      {
        id: 'thinking-1',
        role: 'assistant',
        kind: 'assistant_thinking',
        content: 'Visible reasoning bubble.',
      },
      {
        id: 'tool-1',
        role: 'assistant',
        kind: 'assistant_tool_call',
        content: 'rg -n "x" src',
        toolCallCommand: 'rg -n "x" src',
        toolCallOutput: 'src/example.ts:1:x',
      },
    ],
    hiddenToolContexts: [],
  } as ChatSession;

  const usage = buildContextUsage(session);

  assert.equal(usage.thinkingUsedTokens, estimateTokenCount('Visible reasoning bubble.'));
  assert.equal(
    usage.chatUsedTokens,
    estimateTokenCount('general, coder friendly assistant')
      + estimateTokenCount('Visible reasoning bubble.')
      + estimateTokenCount('Tool call: rg -n "x" src\n\nResult:\nsrc/example.ts:1:x'),
  );
});
