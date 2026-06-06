import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import {
  appendChatMessagesWithUsage,
  buildChatHistoryMessages,
  buildChatSystemContent,
  buildContextUsage,
  buildRetainedWebToolCalls,
  buildRepoSearchMarkdown,
  buildPersistTurnsFromRepoSearchResult,
} from '../src/status-server/chat.ts';
import { buildChatPromptContext } from '../src/status-server/chat-prompt-context.ts';
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
      groundingStatus: 'fetched',
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
  const answerMessage = session.messages.find((m) => m.kind === 'assistant_answer' && m.content === 'Tool calls are handled in engine.ts.');
  assert.equal(toolMessage?.outputTokensEstimate, 295);
  assert.equal(toolMessage?.associatedToolTokens, 295);
  assert.equal(answerMessage?.groundingStatus, 'fetched');
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
  const usage = buildContextUsage(null, session);

  assert.equal(usage.chatUsedTokens, expectedChatTokens);
  assert.equal(usage.usedTokens, expectedChatTokens);
  assert.equal(usage.thinkingUsedTokens, expectedThinkingTokens);
  assert.equal(usage.toolUsedTokens, expectedToolTokens);
  assert.equal(usage.totalUsedTokens, expectedChatTokens + expectedToolTokens);
  assert.equal(usage.estimatedTokenFallbackTokens, 0);
  assert.equal(typeof usage.providerOverheadTokens, 'number');
  assert.equal(Number.isInteger(usage.providerOverheadTokens), true);
  assert.equal(usage.providerOverheadTokens >= 0, true);
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

  const usage = buildContextUsage(null, session);

  assert.equal(usage.thinkingUsedTokens, estimateTokenCount('Visible reasoning bubble.'));
  assert.equal(
    usage.chatUsedTokens,
    estimateTokenCount('general, coder friendly assistant')
      + estimateTokenCount('Visible reasoning bubble.')
      + estimateTokenCount('Tool call: rg -n "x" src\n\nResult:\nsrc/example.ts:1:x'),
  );
  assert.equal(typeof usage.providerOverheadTokens, 'number');
  assert.equal(Number.isInteger(usage.providerOverheadTokens), true);
  assert.equal(usage.providerOverheadTokens >= 0, true);
});

test('buildChatHistoryMessages maps prior turns to user/assistant roles', () => {
  const session = {
    id: 's1',
    messages: [
      { id: 'a', role: 'user', kind: 'user_text', content: 'hi' },
      { id: 'b', role: 'assistant', kind: 'assistant_answer', content: 'hello' },
      { id: 'c', role: 'assistant', kind: 'assistant_thinking', content: 'pondering' },
    ],
  };
  const history = buildChatHistoryMessages({}, session as never);
  assert.deepEqual(history, [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' },
  ]);
});

test('chat replay context excludes internal logic and includes only follow-up-visible turns', () => {
  const session = {
    id: 's1',
    messages: [
      { id: 'u1', role: 'user', kind: 'user_text', content: 'visible question', inputTokensEstimate: 99999 },
      { id: 't1', role: 'assistant', kind: 'assistant_tool_call', content: 'web_search query="x"', outputTokensEstimate: 1234 },
      { id: 'h1', role: 'assistant', kind: 'assistant_thinking', content: 'hidden reasoning', thinkingTokens: 5678 },
      { id: 'a1', role: 'assistant', kind: 'assistant_answer', content: 'visible answer', outputTokensEstimate: 88888 },
    ],
  };

  assert.deepEqual(buildChatHistoryMessages({}, session as never), [
    { role: 'user', content: 'visible question' },
    { role: 'assistant', content: 'visible answer' },
  ]);
});

test('buildContextUsage counts replay-visible context, not internal tool telemetry', () => {
  const session = {
    id: 'session-replay-usage',
    contextWindowTokens: 62000,
    messages: [
      { id: 'u1', role: 'user', kind: 'user_text', content: 'tiny', inputTokensEstimate: 161239 },
      { id: 't1', role: 'assistant', kind: 'assistant_tool_call', content: 'web_fetch url="https://example.test"', outputTokensEstimate: 42073 },
      { id: 'a1', role: 'assistant', kind: 'assistant_answer', content: 'short answer', outputTokensEstimate: 2048 },
    ],
    hiddenToolContexts: [],
  } as ChatSession;

  const usage = buildContextUsage(createConfig(), session);

  assert.ok(usage.chatUsedTokens < 1000);
  assert.equal(usage.toolUsedTokens, 0);
  assert.equal(usage.contextWindowTokens, 62000);
});

test('appendChatMessagesWithUsage stores user text token estimate from content, not cumulative prompt eval telemetry', () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-chat-user-tokens-'));
  const session = {
    id: 'session-user-tokens',
    title: 'Session',
    model: 'managed.gguf',
    contextWindowTokens: 8192,
    createdAtUtc: '2026-04-17T00:00:00.000Z',
    updatedAtUtc: '2026-04-17T00:00:00.000Z',
    messages: [],
  } as ChatSession;

  const updated = appendChatMessagesWithUsage(runtimeRoot, session, 'tiny', 'answer', {
    promptTokens: null,
    completionTokens: 4,
    thinkingTokens: 0,
    promptCacheTokens: 1204807,
    promptEvalTokens: 161239,
  }, { turns: [] });

  const userMessage = updated.messages.find((message) => message.kind === 'user_text');
  assert.ok(userMessage);
  assert.equal(userMessage.inputTokensEstimate, estimateTokenCount('tiny'));
  assert.equal(userMessage.inputTokensEstimated, true);
});

test('buildRetainedWebToolCalls extracts undeleted web calls from internal tool messages', () => {
  const session = {
    id: 'session-retained-web',
    messages: [
      { id: 's1', role: 'assistant', kind: 'assistant_tool_call', toolCallCommand: 'web_search query="OSRS iron bars uses other than smithing"' },
      { id: 's2', role: 'assistant', kind: 'assistant_tool_call', toolCallCommand: 'web_search query="foo \\"bar\\" OSRS"' },
      { id: 'f1', role: 'assistant', kind: 'assistant_tool_call', toolCallCommand: 'web_fetch url="https://oldschool.runescape.wiki/w/Iron_bar"' },
      { id: 'a1', role: 'assistant', kind: 'assistant_answer', content: 'answer' },
    ],
  } as ChatSession;

  assert.deepEqual(buildRetainedWebToolCalls(session), [
    { toolName: 'web_search', value: 'OSRS iron bars uses other than smithing' },
    { toolName: 'web_search', value: 'foo "bar" OSRS' },
    { toolName: 'web_fetch', value: 'https://oldschool.runescape.wiki/w/Iron_bar' },
  ]);
});

test('buildRetainedWebToolCalls ignores deleted tool messages because they are absent from the session', () => {
  const session = {
    id: 'session-retained-web-deleted',
    messages: [
      { id: 'a1', role: 'assistant', kind: 'assistant_answer', content: 'answer' },
    ],
  } as ChatSession;

  assert.deepEqual(buildRetainedWebToolCalls(session), []);
});

test('buildChatSystemContent returns the default chat system prompt', () => {
  const content = buildChatSystemContent({}, { id: 's', messages: [] } as never);
  assert.match(content, /coder friendly assistant/);
});
