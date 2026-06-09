import test from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import { executeRepoSearchRequest } from '../src/repo-search/execute.js';
import type { RepoSearchProgressEvent } from '../src/repo-search/types.js';

const MOCK_CONFIG = {
  Runtime: { Model: 'mock', LlamaCpp: { BaseUrl: 'http://127.0.0.1:1', NumCtx: 32000 } },
};

test('executeRepoSearchRequest chat kind returns finalOutput in scorecard, no tools', async () => {
  const events: RepoSearchProgressEvent[] = [];
  const result = await executeRepoSearchRequest({
    prompt: 'What did I just say?',
    repoRoot: os.tmpdir(),
    config: MOCK_CONFIG,
    taskKind: 'chat',
    systemPrompt: 'general, coder friendly assistant',
    history: [{ role: 'user', content: 'I like green.' }, { role: 'assistant', content: 'Noted.' }],
    allowedTools: [],
    availableModels: ['mock'],
    model: 'mock',
    mockResponses: ['{"action":"finish","output":"You like green."}'],
    onProgress: (event) => { events.push(event); },
  });
  const tasks = (result.scorecard as { tasks: Array<{ finalOutput: string; groundingStatus?: string }> }).tasks;
  assert.equal(tasks[0].finalOutput, 'You like green.');
  assert.equal(tasks[0].groundingStatus, undefined);
  assert.ok(events.some((event) => event.kind === 'answer' && event.answerText === 'You like green.'));
});

test('executeRepoSearchRequest chat with web tools runs native web_search', async () => {
  const events: RepoSearchProgressEvent[] = [];
  const result = await executeRepoSearchRequest({
    prompt: 'Current GE price of an iron bar?',
    repoRoot: os.tmpdir(),
    taskKind: 'chat',
    systemPrompt: 'general, coder friendly assistant',
    allowedTools: ['web_search', 'web_fetch'],
    availableModels: ['mock'],
    model: 'mock',
    config: {
      Runtime: { Model: 'mock', LlamaCpp: { BaseUrl: 'http://127.0.0.1:1', NumCtx: 32000 } },
      WebSearch: { EnabledDefault: true, Providers: { tavily: { Enabled: true, ApiKey: 'test-key' }, firecrawl: { Enabled: false, ApiKey: '' } }, ProviderOrder: ['tavily', 'firecrawl'], ResultCount: 5, FetchMaxPages: 3, TimeoutMs: 15000, FetchMaxCharacters: 12000 },
    },
    mockResponses: [
      '{"action":"web_search","query":"iron bar GE price"}',
      '{"action":"web_fetch","url":"https://prices.runescape.wiki/iron-bar"}',
      '{"action":"finish","output":"About 150 gp per bar."}',
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
    onProgress: (event) => { events.push(event); },
  });
  const tasks = (result.scorecard as { tasks: Array<{ finalOutput: string }> }).tasks;
  assert.equal(tasks[0].finalOutput, 'About 150 gp per bar.');
  assert.ok(events.some((event) => event.kind === 'tool_start'), 'expected tool_start');
  assert.ok(events.some((event) => event.kind === 'tool_result'), 'expected tool_result');
});

test('chat with web tools rejects snippet-only finish and requires web_fetch', async () => {
  const result = await executeRepoSearchRequest({
    taskKind: 'chat',
    prompt: 'What are the major milestones for fastest F2P ironman iron ore?',
    repoRoot: process.cwd(),
    statusBackendUrl: 'http://127.0.0.1:1/status',
    config: MOCK_CONFIG,
    systemPrompt: 'general, coder friendly assistant',
    history: [],
    thinkingEnabled: false,
    allowedTools: ['web_search', 'web_fetch'],
    availableModels: ['mock'],
    model: 'mock',
    maxTurns: 4,
    mockResponses: [
      '{"action":"web_search","query":"OSRS F2P ironman fastest iron ore milestones"}',
      '{"action":"finish","output":"Use the Mining Guild at level 30 after Doric\'s Quest."}',
      '{"action":"web_fetch","url":"https://oldschool.runescape.wiki/w/Mining_Guild"}',
      '{"action":"finish","output":"Fetched evidence says the Mining Guild requires 60 Mining, so level 60 is the relevant milestone."}',
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

  const tasks = (result.scorecard as { tasks: Array<{ finalOutput: string; groundingStatus?: string }> }).tasks;
  const task = tasks[0];

  assert.match(String(task.finalOutput), /requires 60 Mining/);
  assert.equal(task.groundingStatus, 'fetched');
  assert.equal((result.scorecard as { verdict: string }).verdict, 'pass');
});

test('chat with web tools rejects finish before web_search and requires fetched evidence', async () => {
  const result = await executeRepoSearchRequest({
    taskKind: 'chat',
    prompt: 'What use are iron bars in OSRS?',
    repoRoot: process.cwd(),
    statusBackendUrl: 'http://127.0.0.1:1/status',
    config: MOCK_CONFIG,
    systemPrompt: 'general, coder friendly assistant',
    history: [],
    thinkingEnabled: false,
    allowedTools: ['web_search', 'web_fetch'],
    availableModels: ['mock'],
    model: 'mock',
    maxTurns: 5,
    mockResponses: [
      '{"action":"finish","output":"Iron bars make kiteshields and random quest rewards."}',
      '{"action":"web_search","query":"OSRS iron bar uses"}',
      '{"action":"web_fetch","url":"https://oldschool.runescape.wiki/w/Iron_bar"}',
      '{"action":"finish","output":"Fetched evidence says iron bars are used as Smithing material and in Construction items."}',
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

  const tasks = (result.scorecard as { tasks: Array<{ finalOutput: string; groundingStatus?: string }> }).tasks;
  const task = tasks[0];

  assert.match(String(task.finalOutput), /Smithing material and in Construction/);
  assert.doesNotMatch(String(task.finalOutput), /kiteshields/);
  assert.equal(task.groundingStatus, 'fetched');
});

test('reported OSRS failure shape fetches before answering milestones', async () => {
  const result = await executeRepoSearchRequest({
    taskKind: 'chat',
    prompt: 'What are the major milestones at which I can get the iron ore fastest as f2p ironman?',
    repoRoot: process.cwd(),
    statusBackendUrl: 'http://127.0.0.1:1/status',
    config: MOCK_CONFIG,
    systemPrompt: 'general, coder friendly assistant',
    history: [],
    thinkingEnabled: false,
    allowedTools: ['web_search', 'web_fetch'],
    availableModels: ['mock'],
    model: 'mock',
    maxTurns: 6,
    mockResponses: [
      '{"action":"web_search","query":"OSRS F2P ironman fastest iron ore mining methods milestones"}',
      '{"action":"finish","output":"Move to the Mining Guild at level 30 after Doric\'s Quest."}',
      '{"action":"web_fetch","url":"https://oldschool.runescape.wiki/w/Mining_Guild"}',
      '{"action":"finish","output":"For F2P ironman iron ore milestones, the fetched source says Mining Guild access requires 60 Mining, so the iron ore milestone is 60 Mining rather than 30."}',
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

  const tasks = (result.scorecard as { tasks: Array<{ finalOutput: string; groundingStatus?: string }> }).tasks;
  const output = String(tasks[0]?.finalOutput || '');

  assert.match(output, /60 Mining/);
  assert.doesNotMatch(output, /level 30/);
  assert.equal(tasks[0]?.groundingStatus, 'fetched');
  assert.equal((result.scorecard as { verdict: string }).verdict, 'pass');
});

test('chat with web tools does not force finish after duplicate web_search', async () => {
  const result = await executeRepoSearchRequest({
    taskKind: 'chat',
    prompt: 'What does OSRS iron bar require?',
    repoRoot: process.cwd(),
    statusBackendUrl: 'http://127.0.0.1:1/status',
    config: MOCK_CONFIG,
    systemPrompt: 'general, coder friendly assistant',
    history: [],
    thinkingEnabled: false,
    allowedTools: ['web_search', 'web_fetch'],
    availableModels: ['mock'],
    model: 'mock',
    maxTurns: 5,
    mockResponses: [
      '{"action":"web_search","query":"osrs iron bar"}',
      '{"action":"web_search","query":"osrs iron bar"}',
      '{"action":"web_fetch","url":"https://oldschool.runescape.wiki/w/Iron_bar"}',
      '{"action":"finish","output":"Fetched evidence says iron bars require 15 Smithing and iron ore."}',
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

  const tasks = (result.scorecard as { tasks: Array<{ commands: Array<{ output: string }>; finalOutput: string }> }).tasks;
  const commands = tasks[0].commands.map((command) => command.output).join('\n');

  assert.match(commands, /already searched/);
  assert.doesNotMatch(commands, /Forced finish mode active/);
  assert.match(String(tasks[0].finalOutput), /15 Smithing/);
});

test('chat with web tools rejects repeated search and fetch calls across the retained loop', async () => {
  const result = await executeRepoSearchRequest({
    taskKind: 'chat',
    prompt: 'What use are iron bars in OSRS?',
    repoRoot: process.cwd(),
    config: MOCK_CONFIG,
    systemPrompt: 'general, coder friendly assistant',
    history: [],
    thinkingEnabled: false,
    allowedTools: ['web_search', 'web_fetch'],
    availableModels: ['mock'],
    model: 'mock',
    maxTurns: 5,
    mockResponses: [
      '{"action":"web_search","query":"OSRS iron bars"}',
      '{"action":"web_search","query":"osrs   IRON bars"}',
      '{"action":"web_fetch","url":"https://oldschool.runescape.wiki/w/Iron_bar"}',
      '{"action":"web_fetch","url":"https://oldschool.runescape.wiki/w/Iron_bar#Uses"}',
      '{"action":"finish","output":"Iron bars are used for Smithing."}',
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
    prompt: 'Hi',
    repoRoot: os.tmpdir(),
    taskKind: 'chat',
    systemPrompt: 'general, coder friendly assistant',
    thinkingEnabled: false,
    allowedTools: [],
    availableModels: ['mock'],
    model: 'mock',
    config: { Runtime: { Model: 'mock', LlamaCpp: { BaseUrl: 'http://127.0.0.1:1', NumCtx: 32000, Reasoning: 'on' } } },
    mockResponses: ['{"action":"finish","output":"Hello"}'],
  });
  const tasks = (result.scorecard as { tasks: Array<{ thinkingTokens: number; finalOutput: string }> }).tasks;
  assert.equal(tasks[0].finalOutput, 'Hello');
  assert.equal(tasks[0].thinkingTokens, 0);
});
