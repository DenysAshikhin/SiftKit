import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { executeRepoSearchRequest } from '../src/repo-search/execute.js';
import type { RepoSearchExecutionResult, RepoSearchProgressEvent } from '../src/repo-search/types.js';
import { PresetCatalog } from '../src/preset-catalog.js';
import { mockSiftConfig, usableWebSearchConfig } from './helpers/mock-config.js';
import { CollectingProgressWriter } from './helpers/collecting-progress-writer.js';
import { DEAD_BASE_URL, DeadEndpointEnv } from './helpers/dead-endpoints.js';
import { parseJsonValueText } from '../src/lib/json.js';
import { JsonObjectSchema } from '../src/lib/json-types.js';
import { z } from '../src/lib/zod.js';
import { TurnModelResponseEventSchema } from '../src/repo-search/live-snapshot/schemas.js';
import { parseRuntimeArtifactUri, readRuntimeArtifact } from '../src/state/runtime-artifacts.js';
import { withTestEnvAndServer } from './_test-helpers.js';

// Execution posts run status; these tests assert on scorecard and progress events only.
const deadEndpoints = new DeadEndpointEnv();
before(() => { deadEndpoints.apply(); });
after(() => { deadEndpoints.restore(); });

const CONTEXT_FREE_PRESETS = PresetCatalog.createDefault().list().map((preset) => ({
  ...preset,
  includeAgentsMd: false,
  includeRepoFileListing: false,
}));

const MOCK_CONFIG = mockSiftConfig({
  Runtime: { LlamaCpp: { BaseUrl: DEAD_BASE_URL, NumCtx: 32000 } },
  Presets: CONTEXT_FREE_PRESETS,
});

// Web-exercising fixtures must clear the web tool policy: an enabled config with a usable provider.
const WEB_MOCK_CONFIG = mockSiftConfig({
  Runtime: { LlamaCpp: { BaseUrl: DEAD_BASE_URL, NumCtx: 32000 } },
  Presets: CONTEXT_FREE_PRESETS,
  WebSearch: usableWebSearchConfig(),
});

function readTranscriptEvents(result: RepoSearchExecutionResult) {
  const transcriptId = parseRuntimeArtifactUri(result.transcriptPath);
  assert.ok(transcriptId);
  const transcript = readRuntimeArtifact(transcriptId);
  return String(transcript?.contentText || '')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JsonObjectSchema.parse(parseJsonValueText(line)));
}

class DisabledCollectingProgressWriter extends CollectingProgressWriter<RepoSearchProgressEvent> {
  override get enabled(): boolean {
    return false;
  }
}

test('executeRepoSearchRequest chat kind returns finalOutput in scorecard, no tools', async () => {
  const events: RepoSearchProgressEvent[] = [];
  const result = await executeRepoSearchRequest({
    presetId: 'chat',
    prompt: 'What did I just say?',
    repoRoot: os.tmpdir(),
    config: MOCK_CONFIG,
    taskKind: 'chat',
    systemPrompt: 'general, coder friendly assistant',
    history: [{ role: 'user', content: 'I like green.' }, { role: 'assistant', content: 'Noted.' }],
    allowedTools: [],
    availableModels: ['mock'],
    model: 'mock',
    mockResponses: [{ content: "You like green." }],
    progressWriter: new CollectingProgressWriter(events),
  });
  const tasks = result.scorecard.tasks;
  assert.equal(tasks[0].finalOutput, 'You like green.');
  assert.equal(tasks[0].groundingStatus, undefined);
  assert.ok(events.some((event) => event.kind === 'answer' && event.answerText === 'You like green.'));
});

test('chat execution persists the provider stop tuple in its JSONL transcript', async () => {
  await withTestEnvAndServer(async ({ tempRoot, stub }) => {
    const result = await executeRepoSearchRequest({
      presetId: 'chat',
      prompt: 'Recover after an interrupted model response.',
      repoRoot: tempRoot,
      config: MOCK_CONFIG,
      taskKind: 'chat',
      systemPrompt: 'general, coder friendly assistant',
      allowedTools: [],
      availableModels: ['mock'],
      model: 'mock',
      statusBackendUrl: stub.statusUrl,
      mockResponses: [
        { content: '', backendEosReason: 'loop_detected' },
        { content: 'Recovered.' },
      ],
    });

    const rawModelResponse = readTranscriptEvents(result)
      .find((event) => event.kind === 'turn_model_response' && event.turn === 1);
    const modelResponse = TurnModelResponseEventSchema.parse(rawModelResponse);
    assert.deepEqual(modelResponse.stop, {
      earlyStopReason: null,
      backendEosReason: 'loop_detected',
      finishReason: null,
    });
  });
});

test('lifecycle reporting stays active without sending live text to a disabled target', async () => {
  const events: RepoSearchProgressEvent[] = [];
  const result = await executeRepoSearchRequest({
    presetId: 'chat',
    prompt: 'Say hello.',
    repoRoot: os.tmpdir(),
    config: MOCK_CONFIG,
    taskKind: 'chat',
    systemPrompt: 'general, coder friendly assistant',
    allowedTools: [],
    availableModels: ['mock'],
    model: 'mock',
    mockResponses: [{ content: "Hello." }],
    progressWriter: new DisabledCollectingProgressWriter(events),
  });

  assert.equal(result.scorecard.tasks[0].finalOutput, 'Hello.');
  assert.ok(events.some((event) => event.kind === 'llm_start'));
  assert.deepEqual(events.filter((event) => event.kind === 'thinking' || event.kind === 'answer'), []);
});

test('executeRepoSearchRequest chat with web tools runs native web_search', async () => {
  const events: RepoSearchProgressEvent[] = [];
  const result = await executeRepoSearchRequest({
    presetId: 'chat',
    prompt: 'Current GE price of an iron bar?',
    repoRoot: os.tmpdir(),
    taskKind: 'chat',
    systemPrompt: 'general, coder friendly assistant',
    allowedTools: ['web_search', 'web_fetch'],
    availableModels: ['mock'],
    model: 'mock',
    config: mockSiftConfig({
      Runtime: { LlamaCpp: { BaseUrl: DEAD_BASE_URL, NumCtx: 32000 } },
      Presets: CONTEXT_FREE_PRESETS,
      WebSearch: usableWebSearchConfig(),
    }),
    mockResponses: [
      { toolCalls: [{ name: "web_search", arguments: {"query":"iron bar GE price"} }] },
      { toolCalls: [{ name: "web_fetch", arguments: {"url":"https://prices.runescape.wiki/iron-bar"} }] },
      { content: "About 150 gp per bar." },
    ],
    mockCommandResults: {
      'web_search query="iron bar GE price"': {
        exitCode: 0,
        stdout: '1. GE\nURL: https://prices.runescape.wiki/iron-bar\nSnippet: iron bar ~150 gp\nSource: tavily',
      },
      'web_fetch url="https://prices.runescape.wiki/iron-bar"': {
        exitCode: 0,
        stdout: 'Fetched page says an iron bar is about 150 gp per bar.',
      },
    },
    progressWriter: new CollectingProgressWriter(events),
  });
  const tasks = result.scorecard.tasks;
  assert.equal(tasks[0].finalOutput, 'About 150 gp per bar.');
  assert.ok(events.some((event) => event.kind === 'tool_start'), 'expected tool_start');
  assert.ok(events.some((event) => event.kind === 'tool_result'), 'expected tool_result');
});

test('chat with web tools rejects snippet-only finish and requires web_fetch', async () => {
  const result = await executeRepoSearchRequest({
    presetId: 'chat',
    taskKind: 'chat',
    prompt: 'What are the major milestones for fastest F2P ironman iron ore?',
    repoRoot: process.cwd(),
    statusBackendUrl: 'http://127.0.0.1:1/status',
    config: WEB_MOCK_CONFIG,
    systemPrompt: 'general, coder friendly assistant',
    history: [],
    thinkingEnabled: false,
    allowedTools: ['web_search', 'web_fetch'],
    webToolsEnabled: true,
    availableModels: ['mock'],
    model: 'mock',
    maxTurns: 4,
    mockResponses: [
      { toolCalls: [{ name: "web_search", arguments: {"query":"OSRS F2P ironman fastest iron ore milestones"} }] },
      { content: "Use the Mining Guild at level 30 after Doric's Quest." },
      { toolCalls: [{ name: "web_fetch", arguments: {"url":"https://oldschool.runescape.wiki/w/Mining_Guild"} }] },
      { content: "Fetched evidence says the Mining Guild requires 60 Mining, so level 60 is the relevant milestone." },
    ],
    mockCommandResults: {
      'web_search query="OSRS F2P ironman fastest iron ore milestones"': {
        exitCode: 0,
        stdout: '1. Mining Guild - OSRS Wiki\nURL: https://oldschool.runescape.wiki/w/Mining_Guild\nSnippet: The Mining Guild contains iron rocks.',
      },
      'web_fetch url="https://oldschool.runescape.wiki/w/Mining_Guild"': {
        exitCode: 0,
        stdout: 'Title: Mining Guild\nURL: https://oldschool.runescape.wiki/w/Mining_Guild\n\nThe Mining Guild requires 60 Mining to enter.',
      },
    },
  });

  const tasks = result.scorecard.tasks;
  const task = tasks[0];

  assert.match(String(task.finalOutput), /requires 60 Mining/);
  assert.equal(task.groundingStatus, 'fetched');
  assert.equal(result.scorecard.verdict, 'pass');
});

test('chat with web tools rejects finish before web_search and requires fetched evidence', async () => {
  const result = await executeRepoSearchRequest({
    presetId: 'chat',
    taskKind: 'chat',
    prompt: 'What use are iron bars in OSRS?',
    repoRoot: process.cwd(),
    statusBackendUrl: 'http://127.0.0.1:1/status',
    config: WEB_MOCK_CONFIG,
    systemPrompt: 'general, coder friendly assistant',
    history: [],
    thinkingEnabled: false,
    allowedTools: ['web_search', 'web_fetch'],
    webToolsEnabled: true,
    availableModels: ['mock'],
    model: 'mock',
    maxTurns: 5,
    mockResponses: [
      { content: "Iron bars make kiteshields and random quest rewards." },
      { toolCalls: [{ name: "web_search", arguments: {"query":"OSRS iron bar uses"} }] },
      { toolCalls: [{ name: "web_fetch", arguments: {"url":"https://oldschool.runescape.wiki/w/Iron_bar"} }] },
      { content: "Fetched evidence says iron bars are used as Smithing material and in Construction items." },
    ],
    mockCommandResults: {
      'web_search query="OSRS iron bar uses"': {
        exitCode: 0,
        stdout: '1. Iron bar - OSRS Wiki\nURL: https://oldschool.runescape.wiki/w/Iron_bar\nSnippet: Iron bars have Smithing and Construction uses.',
      },
      'web_fetch url="https://oldschool.runescape.wiki/w/Iron_bar"': {
        exitCode: 0,
        stdout: 'Title: Iron bar\nURL: https://oldschool.runescape.wiki/w/Iron_bar\n\nIron bars can be used for Smithing and Construction items.',
      },
    },
  });

  const tasks = result.scorecard.tasks;
  const task = tasks[0];

  assert.match(String(task.finalOutput), /Smithing material and in Construction/);
  assert.doesNotMatch(String(task.finalOutput), /kiteshields/);
  assert.equal(task.groundingStatus, 'fetched');
});

test('reported OSRS failure shape fetches before answering milestones', async () => {
  const result = await executeRepoSearchRequest({
    presetId: 'chat',
    taskKind: 'chat',
    prompt: 'What are the major milestones at which I can get the iron ore fastest as f2p ironman?',
    repoRoot: process.cwd(),
    statusBackendUrl: 'http://127.0.0.1:1/status',
    config: WEB_MOCK_CONFIG,
    systemPrompt: 'general, coder friendly assistant',
    history: [],
    thinkingEnabled: false,
    allowedTools: ['web_search', 'web_fetch'],
    webToolsEnabled: true,
    availableModels: ['mock'],
    model: 'mock',
    maxTurns: 6,
    mockResponses: [
      { toolCalls: [{ name: "web_search", arguments: {"query":"OSRS F2P ironman fastest iron ore mining methods milestones"} }] },
      { content: "Move to the Mining Guild at level 30 after Doric's Quest." },
      { toolCalls: [{ name: "web_fetch", arguments: {"url":"https://oldschool.runescape.wiki/w/Mining_Guild"} }] },
      { content: "For F2P ironman iron ore milestones, the fetched source says Mining Guild access requires 60 Mining, so the iron ore milestone is 60 Mining rather than 30." },
    ],
    mockCommandResults: {
      'web_search query="OSRS F2P ironman fastest iron ore mining methods milestones"': {
        exitCode: 0,
        stdout: '1. Mining Guild - OSRS Wiki\nURL: https://oldschool.runescape.wiki/w/Mining_Guild\nSnippet: The guild has iron rocks near a bank.',
      },
      'web_fetch url="https://oldschool.runescape.wiki/w/Mining_Guild"': {
        exitCode: 0,
        stdout: 'Title: Mining Guild\nURL: https://oldschool.runescape.wiki/w/Mining_Guild\n\nPlayers need level 60 Mining to enter the Mining Guild.',
      },
    },
  });

  const tasks = result.scorecard.tasks;
  const output = String(tasks[0]?.finalOutput || '');

  assert.match(output, /60 Mining/);
  assert.doesNotMatch(output, /level 30/);
  assert.equal(tasks[0]?.groundingStatus, 'fetched');
  assert.equal(result.scorecard.verdict, 'pass');
});

test('chat with web tools does not force finish after duplicate web_search', async () => {
  const result = await executeRepoSearchRequest({
    presetId: 'chat',
    taskKind: 'chat',
    prompt: 'What does OSRS iron bar require?',
    repoRoot: process.cwd(),
    statusBackendUrl: 'http://127.0.0.1:1/status',
    config: WEB_MOCK_CONFIG,
    systemPrompt: 'general, coder friendly assistant',
    history: [],
    thinkingEnabled: false,
    allowedTools: ['web_search', 'web_fetch'],
    webToolsEnabled: true,
    availableModels: ['mock'],
    model: 'mock',
    maxTurns: 5,
    mockResponses: [
      { toolCalls: [{ name: "web_search", arguments: {"query":"osrs iron bar"} }] },
      { toolCalls: [{ name: "web_search", arguments: {"query":"osrs iron bar"} }] },
      { toolCalls: [{ name: "web_fetch", arguments: {"url":"https://oldschool.runescape.wiki/w/Iron_bar"} }] },
      { content: "Fetched evidence says iron bars require 15 Smithing and iron ore." },
    ],
    mockCommandResults: {
      'web_search query="osrs iron bar"': {
        exitCode: 0,
        stdout: '1. Iron bar - OSRS Wiki\nURL: https://oldschool.runescape.wiki/w/Iron_bar\nSnippet: An iron bar can be created with Smithing.',
      },
      'web_fetch url="https://oldschool.runescape.wiki/w/Iron_bar"': {
        exitCode: 0,
        stdout: 'Title: Iron bar\nURL: https://oldschool.runescape.wiki/w/Iron_bar\n\nIt can be created through Smithing at level 15 by using iron ore on a furnace.',
      },
    },
  });

  const tasks = result.scorecard.tasks;
  const commands = tasks[0].commands.map((command) => command.output).join('\n');

  assert.match(commands, /already searched/);
  assert.doesNotMatch(commands, /Forced finish mode active/);
  assert.match(String(tasks[0].finalOutput), /15 Smithing/);
});

test('chat with web tools rejects repeated search and fetch calls across the retained loop', async () => {
  const result = await executeRepoSearchRequest({
    presetId: 'chat',
    taskKind: 'chat',
    prompt: 'What use are iron bars in OSRS?',
    repoRoot: process.cwd(),
    config: WEB_MOCK_CONFIG,
    systemPrompt: 'general, coder friendly assistant',
    history: [],
    thinkingEnabled: false,
    allowedTools: ['web_search', 'web_fetch'],
    webToolsEnabled: true,
    availableModels: ['mock'],
    model: 'mock',
    maxTurns: 5,
    mockResponses: [
      { toolCalls: [{ name: "web_search", arguments: {"query":"OSRS iron bars"} }] },
      { toolCalls: [{ name: "web_search", arguments: {"query":"osrs   IRON bars"} }] },
      { toolCalls: [{ name: "web_fetch", arguments: {"url":"https://oldschool.runescape.wiki/w/Iron_bar"} }] },
      { toolCalls: [{ name: "web_fetch", arguments: {"url":"https://oldschool.runescape.wiki/w/Iron_bar#Uses"} }] },
      { content: "Iron bars are used for Smithing." },
    ],
    mockCommandResults: {
      'web_search query="OSRS iron bars"': {
        exitCode: 0,
        stdout: 'URL: https://oldschool.runescape.wiki/w/Iron_bar',
      },
      'web_fetch url="https://oldschool.runescape.wiki/w/Iron_bar"': {
        exitCode: 0,
        stdout: 'Iron bar page text',
      },
    },
  });

  const transcript = JSON.stringify(result.scorecard);
  assert.match(transcript, /already searched/u);
  assert.match(transcript, /already fetched/u);
  assert.doesNotMatch(transcript, /Forced finish mode active/u);
  assert.match(transcript, /Iron bars are used for Smithing/u);
});

test('chat executor with thinking off yields zero thinking tokens', async () => {
  const result = await executeRepoSearchRequest({
    presetId: 'chat',
    prompt: 'Hi',
    repoRoot: os.tmpdir(),
    taskKind: 'chat',
    systemPrompt: 'general, coder friendly assistant',
    thinkingEnabled: false,
    allowedTools: [],
    availableModels: ['mock'],
    model: 'mock',
    config: mockSiftConfig({
      Runtime: { LlamaCpp: { BaseUrl: DEAD_BASE_URL, NumCtx: 32000 } },
      Presets: CONTEXT_FREE_PRESETS,
      Server: { ModelPresets: { ActivePresetId: 'default', Presets: [{ id: 'default', Reasoning: 'on', IdleAction: 'unload' }] } },
    }),
    mockResponses: [{ content: "Hello" }],
  });
  const tasks = result.scorecard.tasks;
  assert.equal(tasks[0].finalOutput, 'Hello');
  assert.equal(tasks[0].thinkingTokens, 0);
});

// The first `turn_new_messages` transcript event carries the exact message list of the first
// model request: system prompt, the history the engine was given, then the initial user turn.
const PlannerLogMessageSchema = z.object({
  role: z.string(),
  content: z.string().optional(),
});
type PlannerLogMessage = z.infer<typeof PlannerLogMessageSchema>;
const LoggedTranscriptEventSchema = z.object({
  kind: z.string(),
  messages: z.array(z.unknown()).optional(),
});

function readFirstTurnMessages(result: RepoSearchExecutionResult): PlannerLogMessage[] {
  const events = readTranscriptEvents(result).map((event) => LoggedTranscriptEventSchema.parse(event));
  const firstTurn = events.find((event) => event.kind === 'turn_new_messages');
  if (!firstTurn?.messages) {
    throw new Error('Expected the transcript to log the first turn messages.');
  }
  return firstTurn.messages.map((message) => PlannerLogMessageSchema.parse(message));
}

const REPO_SEARCH_TOOL_CALLS = [
  { toolCalls: [{ name: 'ls', arguments: { path: '.', limit: 1 } }] },
  { toolCalls: [{ name: 'ls', arguments: { path: 'src', limit: 1 } }] },
  { toolCalls: [{ name: 'find', arguments: { pattern: '*.ts' } }] },
  { toolCalls: [{ name: 'grep', arguments: { pattern: 'target' } }] },
  { toolCalls: [{ name: 'read', arguments: { path: 'src/main.ts' } }] },
];

test('repo-search task kind honors supplied history in the model call', async () => {
  await withTestEnvAndServer(async (context) => {
    const result = await executeRepoSearchRequest({
      presetId: 'repo-search',
      prompt: 'find the target symbol',
      repoRoot: context.tempRoot,
      config: MOCK_CONFIG,
      taskKind: 'repo-search',
      history: [
        { role: 'user', content: 'earlier question' },
        { role: 'assistant', content: 'earlier answer' },
      ],
      statusBackendUrl: context.stub.statusUrl,
      availableModels: ['mock'],
      model: 'mock',
      mockResponses: [...REPO_SEARCH_TOOL_CALLS, { content: 'done' }],
      mockCommandResults: {},
    });
    const messages = readFirstTurnMessages(result);
    assert.deepEqual(messages.map((message) => message.role), ['system', 'user', 'assistant', 'user']);
    assert.equal(messages[1].content, 'earlier question');
    assert.equal(messages[2].content, 'earlier answer');
    assert.match(String(messages[3].content), /find the target symbol/u);
  });
});

test('repo-search task kind without history leaves the model call historyless', async () => {
  await withTestEnvAndServer(async (context) => {
    const result = await executeRepoSearchRequest({
      presetId: 'repo-search',
      prompt: 'find the target symbol',
      repoRoot: context.tempRoot,
      config: MOCK_CONFIG,
      taskKind: 'repo-search',
      statusBackendUrl: context.stub.statusUrl,
      availableModels: ['mock'],
      model: 'mock',
      mockResponses: [...REPO_SEARCH_TOOL_CALLS, { content: 'done' }],
      mockCommandResults: {},
    });
    const messages = readFirstTurnMessages(result);
    assert.deepEqual(messages.map((message) => message.role), ['system', 'user']);
    assert.match(String(messages[1].content), /find the target symbol/u);
  });
});
