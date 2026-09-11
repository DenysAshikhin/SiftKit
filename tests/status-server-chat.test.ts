import assert from 'node:assert/strict';
import test from 'node:test';

import { buildChatHistoryMessages } from '../src/status-server/chat-history-import.js';
import {
  buildChatSystemContent,
  buildContextUsage,
  buildRetainedWebToolCalls,
  buildRepoSearchMarkdown,
  resolveChatSessionModel,
  resolveChatSessionContextWindow,
  resolveChatSessionConfig,
  sessionUsesActiveModelPreset,
} from '../src/status-server/chat.js';
import { buildChatSessionResponse } from '../src/status-server/chat-session-response.js';
import {
  getActiveModelPreset,
  getConfiguredEngineNumCtx,
  getConfiguredModel,
  getConfiguredReasoning,
} from '../src/config/getters.js';
import { getDefaultConfigObject } from '../src/config/defaults.js';
import { mergeConfig } from '../src/config/normalization.js';
import { buildChatPromptContext } from '../src/status-server/chat-prompt-context.js';
import { normalizeConfig } from '../src/status-server/config-store.js';
import { estimateTokenCount, type ChatSession } from '../src/state/chat-sessions.js';
import { z } from '../src/lib/zod.js';
import { JsonValueSchema, type JsonObject } from '../src/lib/json-types.js';
import type { SiftConfig } from '../src/config/types.js';
import { mockModelPreset } from './helpers/mock-config.js';
import {
  ChatTranscriptMessageKindSchema,
  ChatTranscriptRoleSchema,
  ImageMetadataSchema,
  PersistedChatTranscriptMessageSchema,
} from '@siftkit/contracts';

// Brand a deliberately-partial session fixture as ChatSession at one boundary;
// tests exercise only the fields they set.
const ChatSessionSchema = z.custom<ChatSession>((value) => typeof value === 'object' && value !== null);
const PartialChatMessageSchema = z.looseObject({
  id: z.string(),
  role: ChatTranscriptRoleSchema,
  kind: ChatTranscriptMessageKindSchema,
  content: z.string().default(''),
  toolCallOutput: z.string().optional(),
  toolCallOutputSnippet: z.string().optional(),
});
const PartialChatSessionSchema = z.looseObject({
  messages: z.array(PartialChatMessageSchema).optional(),
});

function mockChatSession(session: object): ChatSession {
  const parsed = PartialChatSessionSchema.parse(session);
  const messages = parsed.messages?.map((message) => {
    const { id, role, kind, content, ...fields } = message;
    const toolOutput = kind === 'assistant_tool_call'
      ? message.toolCallOutput ?? message.toolCallOutputSnippet ?? ''
      : '';
    return PersistedChatTranscriptMessageSchema.parse({
      inputTokensEstimate: 0,
      outputTokensEstimate: estimateTokenCount(toolOutput),
      thinkingTokens: 0,
      createdAtUtc: '2026-01-01T00:00:00.000Z',
      sourceRunId: null,
      ...(kind === 'assistant_tool_call' ? {
        toolCallCommand: content || 'command',
        toolCallActivityKind: 'command',
        toolCallActivitySubject: { kind: 'none' },
        toolCallTurn: 1,
        toolCallMaxTurns: 45,
        toolCallExitCode: 0,
        toolCallExecutionState: 'completed',
        toolCallStatus: 'done',
      } : {}),
      ...fields,
      id,
      role,
      kind,
      content,
    });
  });
  return ChatSessionSchema.parse({ modelPresetId: 'default', planRepoRoot: process.cwd(), ...parsed, messages });
}

function createConfig(overrides: JsonObject = {}): SiftConfig {
  return normalizeConfig(mergeConfig(JsonValueSchema.parse(getDefaultConfigObject()), {
    Server: {
      ModelPresets: {
        ActivePresetId: 'default',
        Presets: [{
          id: 'default',
          label: 'Default',
          Backend: 'exl3',
          Model: 'managed-model',
          ModelPath: 'managed-model',
          BaseUrl: 'http://127.0.0.1:8080',
          NumCtx: 8192,
          Temperature: 0.7,
          TopP: 0.9,
          TopK: 40,
          MinP: 0.05,
          PresencePenalty: 0,
          RepetitionPenalty: 1.1,
          ParallelSlots: 1,
          Reasoning: 'on',
          ReasoningContent: true,
          PreserveThinking: true,
          MaintainPerStepThinking: true,
          IdleAction: 'unload',
        }],
      },
    },
    ...overrides,
  }));
}

function createNoThinkingReplayConfig(): SiftConfig {
  return createConfig({
    Server: {
      ModelPresets: {
        ActivePresetId: 'default',
        Presets: [{
          id: 'default',
          Reasoning: 'off',
          ReasoningContent: false,
          PreserveThinking: false,
          IdleAction: 'unload',
        }],
      },
    },
  });
}

function createSession(): ChatSession {
  return mockChatSession({
    id: 'session-1',
    title: 'Session',
    modelPresetId: 'default',
    presetId: 'chat',
    mode: 'chat',
    modelPreset: mockModelPreset({ id: 'default', Model: 'managed-exl3', NumCtx: 8192 }),
    thinkingEnabled: true,
    createdAtUtc: '2026-04-17T00:00:00.000Z',
    updatedAtUtc: '2026-04-17T00:00:00.000Z',
    messages: [
      {
        id: 'assistant-1',
        role: 'assistant',
        kind: 'assistant_answer',
        content: 'final answer',
        thinkingContent: 'prior thinking',
        inputTokensEstimate: 0,
        outputTokensEstimate: 0,
        thinkingTokens: 0,
        createdAtUtc: '2026-04-17T00:00:00.000Z',
      },
      {
        id: 'assistant-2',
        role: 'assistant',
        kind: 'assistant_answer',
        content: 'answer without thinking',
        thinkingContent: '',
        inputTokensEstimate: 0,
        outputTokensEstimate: 0,
        thinkingTokens: 0,
        createdAtUtc: '2026-04-17T00:00:00.000Z',
      },
    ],
  });
}

test('active model preset identity uses current configured inference metadata', () => {
  const config = createConfig();
  const preset = getActiveModelPreset(config);
  preset.Backend = 'exl3';
  preset.Model = 'active-model';
  preset.NumCtx = 150_000;

  const staleSnapshotSession = mockChatSession({
    id: 'active',
    modelPresetId: 'default',
    modelPreset: mockModelPreset({ id: 'default', Model: 'stale-model-snapshot', NumCtx: 30_000 }),
  });
  assert.equal(resolveChatSessionContextWindow(config, staleSnapshotSession), 150_000);
  assert.equal(resolveChatSessionModel(config, staleSnapshotSession), 'active-model');
  assert.equal(resolveChatSessionConfig(config, staleSnapshotSession), config);
});

test('inactive model preset identity preserves inference snapshots', () => {
  const config = createConfig();
  getActiveModelPreset(config).Model = 'active-model';

  const session = mockChatSession({
    id: 'historical',
    modelPresetId: 'historical-preset',
    modelPreset: mockModelPreset({
      id: 'historical-preset',
      Backend: 'exl3',
      Model: 'historical-model',
      NumCtx: 30_000,
      Temperature: 0.2,
    }),
  });
  assert.equal(sessionUsesActiveModelPreset(config, session), false);
  assert.equal(resolveChatSessionContextWindow(config, session), 30_000);
  assert.equal(resolveChatSessionModel(config, session), 'historical-model');

  // The snapshot preset becomes the active preset for every request the session drives.
  const resolved = resolveChatSessionConfig(config, session);
  assert.equal(getActiveModelPreset(resolved).Temperature, 0.2);
  assert.equal(getConfiguredModel(resolved), 'historical-model');
  assert.equal(getConfiguredEngineNumCtx(resolved), 30_000);
});

// The substituted snapshot must reach the resolved runtime too, or the session would run
// against the live preset's context window.
test('a snapshot session runs against its own context window and reasoning mode', () => {
  const config = createConfig();
  const session = mockChatSession({
    id: 'historical-removed-backend',
    modelPresetId: 'historical-preset',
    modelPreset: mockModelPreset({
      id: 'historical-preset',
      Backend: 'exl3',
      Model: 'historical-model',
      NumCtx: 30_000,
      Reasoning: 'off',
    }),
  });

  const resolved = resolveChatSessionConfig(config, session);

  assert.equal(getConfiguredEngineNumCtx(resolved), 30_000);
  assert.equal(getConfiguredReasoning(resolved), 'off');
  assert.equal(resolveChatSessionContextWindow(config, session), getConfiguredEngineNumCtx(resolved));
});

test('substituting a snapshot preset keeps the other presets resolvable', () => {
  const config = createConfig();
  config.Server.ModelPresets.Presets.push(mockModelPreset({ id: 'second', Model: 'second-model' }));
  const session = mockChatSession({
    id: 'historical-sibling',
    modelPresetId: 'historical-preset',
    modelPreset: mockModelPreset({ id: 'historical-preset', Model: 'historical-model', NumCtx: 30_000 }),
  });

  const resolved = resolveChatSessionConfig(config, session);

  assert.equal(resolved.Server.ModelPresets.Presets.length, 2);
  assert.equal(resolved.Server.ModelPresets.Presets[1]?.Model, 'second-model');
  assert.equal(getActiveModelPreset(resolved).id, 'default');
});

test('inactive model preset identity rejects an invalid context snapshot', () => {
  const config = createConfig();
  const preset = getActiveModelPreset(config);
  preset.Backend = 'exl3';
  preset.NumCtx = 150_000;

  assert.throws(
    () => resolveChatSessionContextWindow(config, mockChatSession({
      id: 'invalid',
      modelPresetId: 'historical-preset',
      modelPreset: mockModelPreset({ id: 'historical-preset', Model: 'historical-model', NumCtx: 0 }),
    })),
    /Chat session invalid has an invalid context window snapshot\./u,
  );
});

test('inactive model preset identity rejects a missing model snapshot', () => {
  const config = createConfig();
  assert.throws(
    () => resolveChatSessionModel(config, mockChatSession({
      id: 'missing-model',
      modelPresetId: 'historical-preset',
      modelPreset: mockModelPreset({ id: 'historical-preset', Model: null, NumCtx: 30_000 }),
    })),
    /Chat session missing-model has an invalid model snapshot\./u,
  );
});

test('buildContextUsage uses the resolved active-model context', () => {
  const config = createConfig();
  const preset = getActiveModelPreset(config);
  preset.Backend = 'exl3';
  preset.Model = 'active-model';
  preset.NumCtx = 150_000;
  preset.VisionMaxImagePixels = 500_000;

  const usage = buildContextUsage(config, mockChatSession({
    id: 'usage',
    modelPresetId: 'default',
    modelPreset: mockModelPreset({ id: 'default', Model: 'stale-model', NumCtx: 30_000 }),
    messages: [],
  }));
  assert.equal(usage.contextWindowTokens, 150_000);
  assert.equal(usage.effectiveImagePixelCeiling, 500_000);
});


test('buildChatSystemContent contains only system prompt and explicit web instruction', () => {
  const session = createSession();
  const config = createConfig();
  const chatPreset = config.Presets.find((preset) => preset.id === 'chat');
  if (!chatPreset) {
    throw new Error('Default chat preset is missing.');
  }
  chatPreset.promptPrefix = 'custom system prompt';

  const systemContent = buildChatSystemContent(config, session);
  const promptContext = buildChatPromptContext(config, session);

  assert.match(systemContent, /coder friendly assistant/u);
  assert.doesNotMatch(systemContent, /custom system prompt/u);
  assert.match(promptContext.content, /custom system prompt/u);
  assert.doesNotMatch(promptContext.content, /Internal tool-call context/u);
});

test('buildChatPromptContext rejects a session without an exact preset id', () => {
  assert.throws(
    () => buildChatPromptContext(
      createConfig(),
      mockChatSession({ id: 'missing-preset', modelPresetId: 'default', mode: 'plan' }),
    ),
    /Chat session presetId is required\./u,
  );
});

test('buildChatPromptContext exposes repo-search tool schema', () => {
  const session = createSession();
  session.mode = 'repo-search';
  session.presetId = 'repo-search';
  session.planRepoRoot = process.cwd();

  const config = createConfig();
  const repoSearchPreset = config.Presets.find((preset) => preset.id === 'repo-search');
  if (!repoSearchPreset) {
    throw new Error('Default repo-search preset is missing.');
  }
  repoSearchPreset.allowedTools = ['grep'];
  repoSearchPreset.promptPrefix = 'extra repo instruction';
  const context = buildChatPromptContext(config, session);

  assert.match(context.content, /System prompt/u);
  assert.match(context.content, /You are a repo-search planner/u);
  assert.match(context.content, /extra repo instruction/u);
  assert.match(context.content, /Tool schema/u);
  const toolSchemaSection = context.content.split('## Tool schema')[1] || '';
  assert.match(toolSchemaSection, /"grep"/u);
  assert.doesNotMatch(toolSchemaSection, /"read"/u);
});

test('buildChatPromptContext exposes the repo-agent system prompt and interactive tool schema', () => {
  const session = createSession();
  session.presetId = 'repo-agent';
  session.planRepoRoot = process.cwd();
  session.webSearchEnabled = false;

  const context = buildChatPromptContext(createConfig(), session);

  assert.equal(context.label, 'System prompt and tool schema');
  assert.match(context.content, /repository coding agent/u);
  assert.doesNotMatch(context.content, /coder friendly assistant/u);
  const toolSchemaSection = context.content.split('## Tool schema')[1] || '';
  for (const toolName of ['read', 'grep', 'find', 'ls', 'git', 'write', 'edit', 'run']) {
    assert.match(toolSchemaSection, new RegExp(`"${toolName}"`, 'u'));
  }
  // Web tools follow the session toggle, so an offline session sees neither.
  assert.doesNotMatch(toolSchemaSection, /"web_search"/u);
  assert.doesNotMatch(toolSchemaSection, /"web_fetch"/u);
});

test('buildChatPromptContext follows the session web-search toggle for repo-agent', () => {
  const config = createConfig({
    WebSearch: { Providers: { tavily: { Enabled: true, ApiKey: 'tavily-key' } } },
  });
  const session = createSession();
  session.presetId = 'repo-agent';
  session.planRepoRoot = process.cwd();

  session.webSearchEnabled = true;
  const withWeb = buildChatPromptContext(config, session);
  assert.match(withWeb.content, /expert coding assistant operating inside SiftKit/u);
  assert.match(withWeb.content.split('## Tool schema')[1] || '', /"web_search"/u);

  session.webSearchEnabled = false;
  const withoutWeb = buildChatPromptContext(config, session);
  const offlineSchema = withoutWeb.content.split('## Tool schema')[1] || '';
  assert.doesNotMatch(offlineSchema, /"web_search"/u);
  assert.doesNotMatch(offlineSchema, /"web_fetch"/u);
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
      tasks: [{ finalOutput: repeatedOutput, maxTurns: 45 }],
    },
  });

  assert.match(markdown, /\| Bank \| helper duplication \|/u);
  assert.equal(markdown.match(/\| Category \| Concern \|/gu)?.length, 1);
});


test('buildContextUsage sums stored session token fields instead of provider prompt telemetry', () => {
  const session: ChatSession = {
    id: 'session-usage',
    title: 'Test session', createdAtUtc: '2026-01-01T00:00:00.000Z', updatedAtUtc: '2026-01-01T00:00:00.000Z',
    modelPresetId: 'default',
    modelPreset: mockModelPreset({ id: 'default', Model: 'managed-exl3', NumCtx: 75000 }),
    planRepoRoot: 'C:/repo',
    messages: [
      {
        id: 'user-1',
        role: 'user',
        kind: 'user_text',
        content: 'How are tool calls handled?',
        inputTokensEstimate: 52403,
        inputTokensEstimated: false,
        outputTokensEstimate: 0,
        thinkingTokens: 0,
        createdAtUtc: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'assistant-1',
        role: 'assistant',
        kind: 'assistant_answer',
        content: '# Repo Search Results\n\nTool calls are parsed and executed through the loop.',
        inputTokensEstimate: 0,
        outputTokensEstimate: 2288,
        outputTokensEstimated: true,
        thinkingTokens: 3405,
        thinkingTokensEstimated: true,
        thinkingContent: 'Prior reasoning that can be replayed.',
        createdAtUtc: '2026-01-01T00:00:00.000Z',
      },
    ],
  };

  const expectedThinkingTokens = 3405;
  const expectedChatTokens = estimateTokenCount('general, coder friendly assistant')
    + 52403
    + 2288
    + expectedThinkingTokens;
  const usage = buildContextUsage(createConfig(), session);

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

test('buildContextUsage sums stored thinking and tool token fields', () => {
  const session = mockChatSession({
    id: 'session-usage-typed',
    modelPreset: mockModelPreset({ id: 'default', Model: 'managed-exl3', NumCtx: 75000 }),
    messages: [
      {
        id: 'thinking-1',
        role: 'assistant',
        kind: 'assistant_thinking',
        content: 'Visible reasoning bubble.',
        thinkingTokens: 42,
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
  });

  const usage = buildContextUsage(createConfig(), session);

  assert.equal(usage.thinkingUsedTokens, 42);
  assert.equal(
    usage.chatUsedTokens,
    estimateTokenCount('general, coder friendly assistant')
      + 42
      + estimateTokenCount('src/example.ts:1:x'),
  );
  assert.equal(usage.toolUsedTokens, estimateTokenCount('src/example.ts:1:x'));
  assert.equal(usage.totalUsedTokens, usage.chatUsedTokens + usage.toolUsedTokens);
  assert.equal(typeof usage.providerOverheadTokens, 'number');
  assert.equal(Number.isInteger(usage.providerOverheadTokens), true);
  assert.equal(usage.providerOverheadTokens >= 0, true);
});

test('buildChatHistoryMessages replays user answers and tool calls in persisted order', () => {
  const session = mockChatSession({
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
  });
  assert.deepEqual(buildChatHistoryMessages(createNoThinkingReplayConfig(), session), [
    { role: 'user', chatMessageId: 'u1', content: 'What did the page say?' },
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
      chatMessageId: 'tool-1',
      tool_call_id: 'chat_tool_tool-1',
      content: 'Title: Example Page\nThe page says iron bars are used in quests.',
    },
    { role: 'assistant', chatMessageId: 'a1', content: 'It says iron bars are used in quests.' },
  ]);
});

test('buildChatHistoryMessages excludes stopped-stream display rows and stopped tools', () => {
  const session = mockChatSession({
    id: 's1',
    messages: [
      { id: 'u1', role: 'user', kind: 'user_text', content: 'Inspect it.' },
      { id: 'n1', role: 'assistant', kind: 'assistant_narration', content: 'Inspecting files.' },
      { id: 'p1', role: 'assistant', kind: 'assistant_progress', content: 'Step 2 of 5' },
      {
        id: 'tool-running',
        role: 'assistant',
        kind: 'assistant_tool_call',
        content: 'web_fetch url="https://example.test/page"',
        toolCallCommand: 'web_fetch url="https://example.test/page"',
        toolCallExecutionState: 'uncertain',
        toolCallStatus: 'stopped',
      },
      { id: 'a1', role: 'assistant', kind: 'assistant_answer', content: 'Partial\n\n*Stopped by user.*' },
    ],
  });

  assert.deepEqual(buildChatHistoryMessages(createNoThinkingReplayConfig(), session), [
    { role: 'user', chatMessageId: 'u1', content: 'Inspect it.' },
    { role: 'assistant', chatMessageId: 'a1', content: 'Partial\n\n*Stopped by user.*' },
  ]);
});

test('buildRetainedWebToolCalls excludes stopped tools', () => {
  const session = mockChatSession({
    id: 's1',
    messages: [{
      id: 'tool-running',
      role: 'assistant',
      kind: 'assistant_tool_call',
      content: 'web_fetch url="https://example.test/page"',
      toolCallCommand: 'web_fetch url="https://example.test/page"',
      toolCallExecutionState: 'uncertain',
      toolCallStatus: 'stopped',
    }],
  });

  assert.deepEqual(buildRetainedWebToolCalls(session), []);
});

test('buildChatHistoryMessages composes the removal notice from the stored count', () => {
  const session = mockChatSession({
    id: 's1',
    messages: [
      { id: 'u1', role: 'user', kind: 'user_text', content: 'compare these', removedImageCount: 2 },
      { id: 'u2', role: 'user', kind: 'user_text', content: '', removedImageCount: 1 },
      { id: 'u3', role: 'user', kind: 'user_text', content: 'no attachments here' },
    ],
  });

  assert.deepEqual(buildChatHistoryMessages(createNoThinkingReplayConfig(), session), [
    { role: 'user', chatMessageId: 'u1', content: 'compare these\n[2 images removed]' },
    { role: 'user', chatMessageId: 'u2', content: '[1 image removed]' },
    { role: 'user', chatMessageId: 'u3', content: 'no attachments here' },
  ]);
});

test('buildChatHistoryMessages carries the removal notice into a tool image replay', () => {
  const imageUrl = 'data:image/png;base64,AA==';
  const session = mockChatSession({
    id: 's1',
    messages: [
      {
        id: 't1',
        role: 'assistant',
        kind: 'tool_image',
        content: 'read output',
        images: [imageUrl],
        removedImageCount: 1,
      },
    ],
  });

  assert.deepEqual(buildChatHistoryMessages(createNoThinkingReplayConfig(), session), [
    {
      role: 'user',
      chatMessageId: 't1',
      content: [
        { type: 'text', text: 'read output\n[1 image removed]' },
        { type: 'image_url', image_url: { url: imageUrl } },
      ],
    },
  ]);
});

test('buildChatHistoryMessages replays persisted repo tool calls with real protocol names', () => {
  const session = mockChatSession({
    id: 's1',
    messages: [
      {
        id: 'tool-2',
        role: 'assistant',
        kind: 'assistant_tool_call',
        content: 'grep pattern="buildChatHistoryMessages" path="src"',
        toolCallCommand: 'grep pattern="buildChatHistoryMessages" path="src"',
        toolCallOutput: 'src/status-server/chat.ts:181:export function buildChatHistoryMessages',
      },
    ],
  });

  assert.deepEqual(buildChatHistoryMessages(createNoThinkingReplayConfig(), session), [
    {
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: 'chat_tool_tool-2',
        type: 'function',
        function: {
          name: 'grep',
          arguments: JSON.stringify({ pattern: 'buildChatHistoryMessages', path: 'src' }),
        },
      }],
    },
    {
      role: 'tool',
      chatMessageId: 'tool-2',
      tool_call_id: 'chat_tool_tool-2',
      content: 'src/status-server/chat.ts:181:export function buildChatHistoryMessages',
    },
  ]);
});

test('buildContextUsage counts replay-visible context, not internal tool telemetry', () => {
  const session: ChatSession = {
    id: 'session-replay-usage',
    title: 'Test session', createdAtUtc: '2026-01-01T00:00:00.000Z', updatedAtUtc: '2026-01-01T00:00:00.000Z',
    modelPresetId: 'historical-preset',
    modelPreset: mockModelPreset({ id: 'historical-preset', Model: 'historical-model', NumCtx: 250_000 }),
    planRepoRoot: 'C:/repo',
    messages: [
      { id: 'u1', role: 'user', kind: 'user_text', content: 'tiny', inputTokensEstimate: 161239, outputTokensEstimate: 0, thinkingTokens: 0, createdAtUtc: '2026-01-01T00:00:00.000Z' },
      {
        id: 't1', role: 'assistant', kind: 'assistant_tool_call', content: 'web_fetch url="https://example.test"',
        inputTokensEstimate: 0, outputTokensEstimate: 42073, thinkingTokens: 0, createdAtUtc: '2026-01-01T00:00:00.000Z',
        toolCallCommand: 'web_fetch url="https://example.test"', toolCallActivityKind: 'web_fetch',
        toolCallActivitySubject: { kind: 'host', value: 'example.test' }, toolCallTurn: 1, toolCallMaxTurns: 45,
        toolCallExitCode: 0, toolCallExecutionState: 'completed',
 toolCallStatus: 'done',
      },
      { id: 'a1', role: 'assistant', kind: 'assistant_answer', content: 'short answer', inputTokensEstimate: 0, outputTokensEstimate: 2048, thinkingTokens: 0, createdAtUtc: '2026-01-01T00:00:00.000Z' },
    ],
  };

  const usage = buildContextUsage(createConfig(), session);

  assert.equal(usage.chatUsedTokens, estimateTokenCount('general, coder friendly assistant') + 161239 + 42073 + 2048);
  assert.equal(usage.toolUsedTokens, 42073);
  assert.equal(usage.totalUsedTokens, usage.chatUsedTokens + 42073);
  assert.equal(usage.remainingTokens, 250_000 - usage.totalUsedTokens);
  assert.equal(usage.contextWindowTokens, 250_000);
});

test('buildContextUsage excludes every compressed message cost and counts the active summary plus live turn', () => {
  const session = mockChatSession({
    ...createSession(),
    messages: [
      {
        id: 'old-user',
        role: 'user',
        kind: 'user_text',
        content: 'X'.repeat(24_000),
        compressedIntoSummary: true,
        imageMeta: [ImageMetadataSchema.parse({
          width: 1024,
          height: 1024,
          originalWidth: 1024,
          originalHeight: 1024,
          mime: 'image/png',
          byteLength: 1,
          tokenEstimate: 2048,
          resized: false,
          caption: null,
        })],
      },
      {
        id: 'old-thinking',
        role: 'assistant',
        kind: 'assistant_thinking',
        content: 'R'.repeat(8_000),
        compressedIntoSummary: true,
      },
      {
        id: 'old-tool',
        role: 'assistant',
        kind: 'assistant_tool_call',
        content: 'grep x',
        toolCallOutput: 'T'.repeat(12_000),
        compressedIntoSummary: true,
      },
      { id: 'summary', role: 'assistant', kind: 'compaction_summary', content: 'short summary' },
      { id: 'live-user', role: 'user', kind: 'user_text', content: 'new question' },
    ],
  });
  const config = createConfig();

  const usage = buildContextUsage(config, session);
  const replay = buildChatHistoryMessages(config, session);

  assert.deepEqual(replay.map((message) => message.role), ['assistant', 'user']);
  assert.equal(usage.toolUsedTokens, 0);
  assert.equal(usage.imageUsedTokens, 0);
  assert.equal(usage.thinkingUsedTokens, 0);
  assert.ok(usage.totalUsedTokens < 1000);
  assert.equal(usage.shouldCondense, false);
});

test('buildChatHistoryMessages replays retained thinking when preserve thinking is enabled', () => {
  const session = mockChatSession({
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
  });

  assert.deepEqual(buildChatHistoryMessages(createConfig(), session), [
    { role: 'user', chatMessageId: 'u1', content: 'What did the page say?' },
    { role: 'assistant', chatMessageId: 'a1', content: 'It says iron bars are used in quests.', reasoning_content: 'private reasoning', thinkingMessageId: 'think-1' },
    {
      role: 'assistant',
      content: '',
      reasoning_content: 'tool reasoning',
      thinkingMessageId: 'think-2',
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
      chatMessageId: 'tool-1',
      tool_call_id: 'chat_tool_tool-1',
      content: 'Title: Example Page',
    },
  ]);
});

test('buildChatHistoryMessages omits retained thinking when preserve thinking is disabled', () => {
  const session = mockChatSession({
    id: 's1',
    thinkingEnabled: true,
    messages: [
      { id: 'think-1', role: 'assistant', kind: 'assistant_thinking', content: 'private reasoning' },
      { id: 'a1', role: 'assistant', kind: 'assistant_answer', content: 'It says iron bars are used in quests.' },
    ],
  });
  const config = createConfig({
    Server: {
      ModelPresets: {
        ActivePresetId: 'default',
        Presets: [{
          id: 'default',
          Reasoning: 'on',
          ReasoningContent: true,
          PreserveThinking: false,
          MaintainPerStepThinking: true,
          IdleAction: 'unload',
        }],
      },
    },
  });

  assert.deepEqual(buildChatHistoryMessages(config, session), [
    { role: 'assistant', chatMessageId: 'a1', content: 'It says iron bars are used in quests.' },
  ]);
});

test('buildRetainedWebToolCalls extracts command result state from undeleted web calls', () => {
  const session = mockChatSession({
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
  });

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
  const session = mockChatSession({
    id: 'session-retained-web-deleted',
    messages: [
      { id: 'a1', role: 'assistant', kind: 'assistant_answer', content: 'answer' },
    ],
  });

  assert.deepEqual(buildRetainedWebToolCalls(session), []);
});

test('buildChatSystemContent returns the default chat system prompt', () => {
  const content = buildChatSystemContent(createConfig(), mockChatSession({ id: 's', messages: [] }));
  assert.match(content, /coder friendly assistant/);
});

test('buildContextUsage counts persisted image tokens', () => {
  const config = createConfig();
  const baseMessage = {
    id: 'u1',
    role: 'user' as const,
    kind: 'user_text' as const,
    content: 'look',
    inputTokensEstimate: 1,
    outputTokensEstimate: 0,
    thinkingTokens: 0,
    createdAtUtc: '2026-08-08T00:00:00.000Z',
  };
  const session = createSession();
  const withoutImages = buildContextUsage(config, mockChatSession({ ...session, messages: [baseMessage] }));
  const withImages = buildContextUsage(config, mockChatSession({
    ...session,
    messages: [{
      ...baseMessage,
      images: ['data:image/png;base64,AA=='],
      imageMeta: [ImageMetadataSchema.parse({
        width: 1024,
        height: 1024,
        originalWidth: 1024,
        originalHeight: 1024,
        mime: 'image/png',
        byteLength: 2048,
        tokenEstimate: 1024,
        resized: false,
        caption: null,
      })],
    }],
  }));

  assert.equal(withoutImages.imageUsedTokens, 0);
  assert.equal(withImages.imageUsedTokens, 1024);
  assert.equal(withImages.chatUsedTokens, withoutImages.chatUsedTokens + 1024);
  assert.equal(withImages.totalUsedTokens, withoutImages.totalUsedTokens + 1024);
});

test('buildChatSessionResponse mirrors the stored repo root onto the wire session', () => {
  const config = createConfig();
  const session = createSession();

  const response = buildChatSessionResponse(config, mockChatSession({ ...session, planRepoRoot: 'C:/srv/pinned' }));

  assert.equal(response.session.planRepoRoot, 'C:/srv/pinned');
});
