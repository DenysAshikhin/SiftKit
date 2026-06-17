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
} from '../src/status-server/chat.js';
import { buildChatPromptContext } from '../src/status-server/chat-prompt-context.js';
import { normalizeConfig } from '../src/status-server/config-store.js';
import { estimateTokenCount, type ChatSession } from '../src/state/chat-sessions.js';
import type { SiftConfig } from '../src/config/types.js';

function createConfig(overrides: Record<string, unknown> = {}): SiftConfig {
  return normalizeConfig({
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
    Presets: [],
    Server: {
      LlamaCpp: {
        ActivePresetId: 'default',
        BaseUrl: 'http://127.0.0.1:8080',
        Presets: [{
          id: 'default',
          label: 'Default',
          LlamaCppPath: '',
          ModelPath: 'managed.gguf',
          Host: '127.0.0.1',
          Port: 8080,
          NumCtx: 8192,
          Temperature: 0.7,
          TopP: 0.9,
          TopK: 40,
          MinP: 0.05,
          PresencePenalty: 0,
          RepetitionPenalty: 1.1,
          ParallelSlots: 1,
          MaxTokens: 512,
          Reasoning: 'on',
          ReasoningContent: true,
          PreserveThinking: true,
          MaintainPerStepThinking: true,
        }],
      },
    },
    ...overrides,
  });
}

function createNoThinkingReplayConfig(): SiftConfig {
  return createConfig({
    Server: {
      LlamaCpp: {
        ActivePresetId: 'default',
        Presets: [{
          id: 'default',
          Reasoning: 'off',
          ReasoningContent: false,
          PreserveThinking: false,
        }],
      },
    },
  });
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
          toolCallOutputSnippet: 'snippet', toolCallOutput: 'x'.repeat(10_000), outputTokens: 295, outputTokensEstimated: false,
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
  assert.equal(toolMessage?.outputTokensEstimated, false);
  assert.equal(toolMessage?.associatedToolTokens, 295);
  assert.equal(answerMessage?.groundingStatus, 'fetched');
});

test('appendChatMessagesWithUsage deletes older thinking transcript entries when per-step thinking is disabled', () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-chat-prune-thinking-'));
  const session = appendChatMessagesWithUsage(
    runtimeRoot,
    createSession(),
    'Find tool call handling.',
    'Tool calls are handled in engine.ts.',
    { promptTokens: 30, completionTokens: 9, thinkingTokens: 0, promptCacheTokens: null, promptEvalTokens: 30 },
    {
      turns: [
        { thinkingText: 'think one', toolMessages: [] },
        { thinkingText: 'think two', toolMessages: [] },
        { thinkingText: 'final think', toolMessages: [] },
      ],
      maintainPerStepThinking: false,
    },
  );

  const thinkingMessages = session.messages.filter((message) => message.kind === 'assistant_thinking');
  assert.equal(thinkingMessages.length, 1);
  assert.equal(thinkingMessages[0].content, 'final think');
  assert.deepEqual(session.messages.slice(2).map((message) => message.kind), [
    'user_text',
    'assistant_thinking',
    'assistant_answer',
  ]);
});

test('appendChatMessagesWithUsage marks explicit estimated tool tokens as estimated', () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-chat-estimated-tool-'));
  const session = appendChatMessagesWithUsage(
    runtimeRoot,
    createSession(),
    'Find tool call handling.',
    'Tool calls are handled in engine.ts.',
    { promptTokens: 30, completionTokens: 9, thinkingTokens: 0, promptCacheTokens: null, promptEvalTokens: 30 },
    {
      turns: [
        { thinkingText: '', toolMessages: [{
          id: 'tool-a', content: 'repo_read_file path="src/x.ts"', toolCallCommand: 'repo_read_file path="src/x.ts"',
          toolCallTurn: 1, toolCallMaxTurns: 1, toolCallExitCode: 0,
          toolCallOutputSnippet: 'snippet', toolCallOutput: 'x'.repeat(10_000), outputTokens: 9048, outputTokensEstimated: true,
        }] },
      ],
    }
  );

  const toolMessage = session.messages.find((m) => m.kind === 'assistant_tool_call');
  assert.equal(toolMessage?.outputTokensEstimate, 9048);
  assert.equal(toolMessage?.outputTokensEstimated, true);
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

test('buildChatSystemContent contains only system prompt and explicit web instruction', () => {
  const session = createSession();

  const systemContent = buildChatSystemContent(createConfig(), session, { promptPrefix: 'custom system prompt' });
  const promptContext = buildChatPromptContext(createConfig(), session, {
    promptPrefix: 'custom system prompt',
    isRepoToolMode: false,
    planRepoRoot: '',
    allowedTools: [],
  });

  assert.equal(systemContent, 'custom system prompt');
  assert.match(promptContext.content, /custom system prompt/u);
  assert.doesNotMatch(promptContext.content, /Internal tool-call context/u);
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
  } as ChatSession;

  const expectedThinkingTokens = estimateTokenCount('Prior reasoning that can be replayed.');
  const expectedChatTokens = estimateTokenCount('general, coder friendly assistant')
    + estimateTokenCount('How are tool calls handled?')
    + estimateTokenCount('# Repo Search Results\n\nTool calls are parsed and executed through the loop.')
    + expectedThinkingTokens;
  const usage = buildContextUsage(null, session);

  assert.equal(usage.chatUsedTokens, expectedChatTokens);
  assert.equal(usage.usedTokens, expectedChatTokens);
  assert.equal(usage.thinkingUsedTokens, expectedThinkingTokens);
  assert.equal(usage.toolUsedTokens, 0);
  assert.equal(usage.totalUsedTokens, expectedChatTokens);
  assert.equal(usage.estimatedTokenFallbackTokens, expectedChatTokens);
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
          outputTokensEstimated: true,
        }],
      }],
    },
  });
  const message = turns[0].toolMessages[0];
  assert.equal(message.toolCallOutput, 'src/repo-search/engine.ts:1613:tool_result');
  assert.equal(message.toolCallOutputSnippet, 'src/repo-search/engine.ts:1613:tool_result');
  assert.equal(message.outputTokens, 295);
  assert.equal(message.outputTokensEstimated, true);
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
  } as ChatSession;

  const usage = buildContextUsage(null, session);

  assert.equal(usage.thinkingUsedTokens, estimateTokenCount('Visible reasoning bubble.'));
  assert.equal(
    usage.chatUsedTokens,
    estimateTokenCount('general, coder friendly assistant')
      + estimateTokenCount('Visible reasoning bubble.')
      + estimateTokenCount('rg -n "x" src'),
  );
  assert.equal(usage.toolUsedTokens, estimateTokenCount('src/example.ts:1:x'));
  assert.equal(usage.totalUsedTokens, usage.chatUsedTokens + usage.toolUsedTokens);
  assert.equal(typeof usage.providerOverheadTokens, 'number');
  assert.equal(Number.isInteger(usage.providerOverheadTokens), true);
  assert.equal(usage.providerOverheadTokens >= 0, true);
});

test('buildChatHistoryMessages replays user answers and tool calls in persisted order', () => {
  const session = {
    id: 's1',
    messages: [
      { id: 'u1', role: 'user', kind: 'user_text', content: 'What did the page say?' },
      {
        id: 'tool-1',
        role: 'assistant',
        kind: 'assistant_tool_call',
        content: 'web_fetch url="https://example.test/page"',
        toolCallCommand: 'web_fetch url="https://example.test/page"',
        toolCallOutput: 'Title: Example Page\nThe page says iron bars are used in quests.',
      },
      { id: 'think-1', role: 'assistant', kind: 'assistant_thinking', content: 'private reasoning' },
      { id: 'a1', role: 'assistant', kind: 'assistant_answer', content: 'It says iron bars are used in quests.' },
    ],
  };
  assert.deepEqual(buildChatHistoryMessages(createNoThinkingReplayConfig(), session as never), [
    { role: 'user', content: 'What did the page say?' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: 'chat_tool_tool-1',
        type: 'function',
        function: {
          name: 'web_fetch',
          arguments: JSON.stringify({ url: 'https://example.test/page' }),
        },
      }],
    },
    {
      role: 'tool',
      tool_call_id: 'chat_tool_tool-1',
      content: 'Title: Example Page\nThe page says iron bars are used in quests.',
    },
    { role: 'assistant', content: 'It says iron bars are used in quests.' },
  ]);
});

test('buildChatHistoryMessages replays persisted repo tool calls with real protocol names', () => {
  const session = {
    id: 's1',
    messages: [
      {
        id: 'tool-2',
        role: 'assistant',
        kind: 'assistant_tool_call',
        content: 'rg -n "buildChatHistoryMessages" src',
        toolCallCommand: 'rg -n "buildChatHistoryMessages" src',
        toolCallOutput: 'src/status-server/chat.ts:181:export function buildChatHistoryMessages',
      },
    ],
  };

  assert.deepEqual(buildChatHistoryMessages(createNoThinkingReplayConfig(), session as never), [
    {
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: 'chat_tool_tool-2',
        type: 'function',
        function: {
          name: 'repo_rg',
          arguments: JSON.stringify({ command: 'rg -n "buildChatHistoryMessages" src' }),
        },
      }],
    },
    {
      role: 'tool',
      tool_call_id: 'chat_tool_tool-2',
      content: 'src/status-server/chat.ts:181:export function buildChatHistoryMessages',
    },
  ]);
});

test('buildContextUsage counts replay-visible context, not internal tool telemetry', () => {
  const session = {
    id: 'session-replay-usage',
    contextWindowTokens: 62000,
    messages: [
      { id: 'u1', role: 'user', kind: 'user_text', content: 'tiny', inputTokensEstimate: 161239 },
      { id: 't1', role: 'assistant', kind: 'assistant_tool_call', content: 'web_fetch url="https://example.test"', outputTokensEstimate: 42073 },
      { id: 'a1', role: 'assistant', kind: 'assistant_answer', content: 'short answer', outputTokensEstimate: 2048, associatedToolTokens: 42073 },
    ],
  } as ChatSession;

  const usage = buildContextUsage(createConfig(), session);

  assert.ok(usage.chatUsedTokens < 1000);
  assert.equal(usage.toolUsedTokens, 42073);
  assert.equal(usage.totalUsedTokens, usage.chatUsedTokens + 42073);
  assert.equal(usage.remainingTokens, 62000 - usage.totalUsedTokens);
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

test('buildChatHistoryMessages replays retained thinking when preserve thinking is enabled', () => {
  const session = {
    id: 's1',
    thinkingEnabled: true,
    messages: [
      { id: 'u1', role: 'user', kind: 'user_text', content: 'What did the page say?' },
      { id: 'think-1', role: 'assistant', kind: 'assistant_thinking', content: 'private reasoning' },
      { id: 'a1', role: 'assistant', kind: 'assistant_answer', content: 'It says iron bars are used in quests.' },
      { id: 'think-2', role: 'assistant', kind: 'assistant_thinking', content: 'tool reasoning' },
      {
        id: 'tool-1',
        role: 'assistant',
        kind: 'assistant_tool_call',
        content: 'web_fetch url="https://example.test/page"',
        toolCallCommand: 'web_fetch url="https://example.test/page"',
        toolCallOutput: 'Title: Example Page',
      },
    ],
  };

  assert.deepEqual(buildChatHistoryMessages(createConfig(), session as never), [
    { role: 'user', content: 'What did the page say?' },
    { role: 'assistant', content: 'It says iron bars are used in quests.', reasoning_content: 'private reasoning' },
    {
      role: 'assistant',
      content: '',
      reasoning_content: 'tool reasoning',
      tool_calls: [{
        id: 'chat_tool_tool-1',
        type: 'function',
        function: {
          name: 'web_fetch',
          arguments: JSON.stringify({ url: 'https://example.test/page' }),
        },
      }],
    },
    {
      role: 'tool',
      tool_call_id: 'chat_tool_tool-1',
      content: 'Title: Example Page',
    },
  ]);
});

test('buildChatHistoryMessages omits retained thinking when preserve thinking is disabled', () => {
  const session = {
    id: 's1',
    thinkingEnabled: true,
    messages: [
      { id: 'think-1', role: 'assistant', kind: 'assistant_thinking', content: 'private reasoning' },
      { id: 'a1', role: 'assistant', kind: 'assistant_answer', content: 'It says iron bars are used in quests.' },
    ],
  };
  const config = createConfig({
    Server: {
      LlamaCpp: {
        ActivePresetId: 'default',
        Presets: [{
          id: 'default',
          Reasoning: 'on',
          ReasoningContent: true,
          PreserveThinking: false,
          MaintainPerStepThinking: true,
        }],
      },
    },
  });

  assert.deepEqual(buildChatHistoryMessages(config, session as never), [
    { role: 'assistant', content: 'It says iron bars are used in quests.' },
  ]);
});

test('appendChatMessagesWithUsage stores exact user text tokens when caller supplies tokenizer count', () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-chat-user-exact-tokens-'));
  const session = {
    id: 'session-user-exact-tokens',
    title: 'Session',
    model: 'managed.gguf',
    contextWindowTokens: 8192,
    createdAtUtc: '2026-04-17T00:00:00.000Z',
    updatedAtUtc: '2026-04-17T00:00:00.000Z',
    messages: [],
  } as ChatSession;

  const updated = appendChatMessagesWithUsage(runtimeRoot, session, 'full user message', 'answer', {
    promptTokens: null,
    completionTokens: 4,
    thinkingTokens: 0,
    promptCacheTokens: null,
    promptEvalTokens: null,
  }, { turns: [], inputTokens: 17, inputTokensEstimated: false });

  const userMessage = updated.messages.find((message) => message.kind === 'user_text');
  assert.ok(userMessage);
  assert.equal(userMessage.inputTokensEstimate, 17);
  assert.equal(userMessage.inputTokensEstimated, false);
});

test('appendChatMessagesWithUsage preserves estimated usage flags on answer tokens', () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-chat-answer-estimated-flags-'));
  const session = appendChatMessagesWithUsage(
    runtimeRoot,
    createSession(),
    'Find token accounting.',
    'Token labels must not claim estimates are known.',
    {
      completionTokens: 11,
      thinkingTokens: 13,
      outputTokensEstimated: true,
      thinkingTokensEstimated: true,
    },
    { turns: [] },
  );

  const answerMessage = session.messages.find((message) => message.kind === 'assistant_answer'
    && message.content === 'Token labels must not claim estimates are known.');
  assert.equal(answerMessage?.outputTokensEstimate, 11);
  assert.equal(answerMessage?.outputTokensEstimated, true);
  assert.equal(answerMessage?.thinkingTokens, 13);
  assert.equal(answerMessage?.thinkingTokensEstimated, true);
});

test('buildRetainedWebToolCalls extracts command result state from undeleted web calls', () => {
  const session = {
    id: 'session-retained-web',
    messages: [
      {
        id: 's1',
        role: 'assistant',
        kind: 'assistant_tool_call',
        toolCallCommand: 'web_search query="OSRS iron bars"',
        toolCallExitCode: 0,
        toolCallOutput: 'URL: https://oldschool.runescape.wiki/w/Iron_bar',
      },
      {
        id: 'f1',
        role: 'assistant',
        kind: 'assistant_tool_call',
        toolCallCommand: 'web_fetch url="https://oldschool.runescape.wiki/w/Iron_bar"',
        toolCallExitCode: 0,
        toolCallOutput: 'Iron bar page text',
      },
    ],
  } as ChatSession;

  assert.deepEqual(buildRetainedWebToolCalls(session), [
    {
      toolName: 'web_search',
      value: 'OSRS iron bars',
      command: 'web_search query="OSRS iron bars"',
      exitCode: 0,
      output: 'URL: https://oldschool.runescape.wiki/w/Iron_bar',
    },
    {
      toolName: 'web_fetch',
      value: 'https://oldschool.runescape.wiki/w/Iron_bar',
      command: 'web_fetch url="https://oldschool.runescape.wiki/w/Iron_bar"',
      exitCode: 0,
      output: 'Iron bar page text',
    },
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
  const content = buildChatSystemContent(createConfig(), { id: 's', messages: [] } as never);
  assert.match(content, /coder friendly assistant/);
});
