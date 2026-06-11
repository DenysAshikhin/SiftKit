import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

type SourceFile = {
  filePath: string;
  text: string;
};

const LLAMA_ENDPOINT_LITERAL_ALLOWLIST = new Set<string>([
  'src/llm-protocol/llama-cpp-client.ts',
  'src/status-server/routes/llama-passthrough.ts',
]);

function listTypeScriptFiles(root: string): SourceFile[] {
  const result: SourceFile[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      result.push(...listTypeScriptFiles(fullPath));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.ts')) {
      result.push({
        filePath: path.relative(process.cwd(), fullPath).replace(/\\/gu, '/'),
        text: fs.readFileSync(fullPath, 'utf8'),
      });
    }
  }
  return result;
}

test('llama.cpp active HTTP request construction lives only in LlamaCppClient', () => {
  const offenders = listTypeScriptFiles(path.join(process.cwd(), 'src'))
    .filter((file) => !LLAMA_ENDPOINT_LITERAL_ALLOWLIST.has(file.filePath))
    .filter((file) => /\/v1\/chat\/completions|\/tokenize|\/v1\/models/u.test(file.text))
    .map((file) => file.filePath)
    .sort();

  assert.deepEqual(offenders, []);
});

test('tool-call protocol parsing has one implementation', () => {
  const offenders = listTypeScriptFiles(path.join(process.cwd(), 'src'))
    .filter((file) => file.filePath !== 'src/llm-protocol/llama-cpp-client.ts')
    .filter((file) => file.filePath !== 'src/llm-protocol/tool-call-parser.ts')
    .filter((file) => file.filePath !== 'src/llm-protocol/streaming-response-assembler.ts')
    .filter((file) => /function_call|delta\.tool_calls|message\?\.tool_calls|choice\?\.tool_calls/u.test(file.text))
    .map((file) => file.filePath)
    .sort();

  assert.deepEqual(offenders, []);
});

test('summary planner does not keep a separate agent loop', () => {
  const modePath = path.join(process.cwd(), 'src', 'summary', 'planner', 'mode.ts');
  const text = fs.readFileSync(modePath, 'utf8');

  assert.equal(/PlannerModeTurnExecutor/u.test(text), false);
  assert.equal(/toolResults\.length\s*<=\s*MAX_PLANNER_TOOL_CALLS/u.test(text), false);
  assert.equal(/requestSummaryPlannerAction|invokePlannerProviderAction|sendSummaryPlannerProviderRequest/u.test(text), false);
  assert.equal(/for\s*\(\s*;\s*toolResults\.length/u.test(text), false);
});

test('repo-search does not keep a separate agent loop', () => {
  const taskLoopPath = path.join(process.cwd(), 'src', 'repo-search', 'engine', 'task-loop.ts');
  const text = fs.readFileSync(taskLoopPath, 'utf8');

  assert.equal(/runAgentLoopTurn/u.test(text), false);
  assert.equal(/requestPlannerAction/u.test(text), false);
  assert.equal(/for\s*\(\s*let\s+turn\s*=/u.test(text), false);
});

test('production repo-search and summary planner use AgentLoop model-client path', () => {
  const productionTexts = [
    fs.readFileSync(path.join(process.cwd(), 'src', 'repo-search', 'engine', 'task-loop.ts'), 'utf8'),
    fs.readFileSync(path.join(process.cwd(), 'src', 'summary', 'planner', 'mode.ts'), 'utf8'),
  ];

  assert.equal(productionTexts.every((text) => /new\s+AgentLoop\b/u.test(text)), true);
  assert.equal(productionTexts.every((text) => /modelClient\s*:/u.test(text)), true);
  assert.equal(productionTexts.every((text) => /turnRunner\s*:/u.test(text) === false), true);
});

test('AgentLoop has no turnRunner shim path', () => {
  const agentLoopText = fs.readFileSync(path.join(process.cwd(), 'src', 'agent-loop', 'agent-loop.ts'), 'utf8');
  const typeText = fs.readFileSync(path.join(process.cwd(), 'src', 'agent-loop', 'types.ts'), 'utf8');

  assert.equal(/turnRunner|AgentLoopTurnRunner|runTurn\s*\(/u.test(agentLoopText), false);
  assert.equal(/AgentLoopTurnRunner|runTurn\s*\(/u.test(typeText), false);
});

test('agent-loop adapters are not turnRunner callbacks', () => {
  const repoAdapter = fs.readFileSync(path.join(process.cwd(), 'src', 'repo-search', 'agent-loop-adapter.ts'), 'utf8');
  const summaryAdapter = fs.readFileSync(path.join(process.cwd(), 'src', 'summary', 'planner', 'agent-loop-adapter.ts'), 'utf8');

  assert.equal(/AgentLoopTurnRunner|runTurn\s*\(|runAgentLoopTurn|runSummaryPlannerTurn/u.test(repoAdapter), false);
  assert.equal(/AgentLoopTurnRunner|runTurn\s*\(|runAgentLoopTurn|runSummaryPlannerTurn/u.test(summaryAdapter), false);
});

test('agent-loop adapters expose all required collaborators', () => {
  const repoAdapter = fs.readFileSync(path.join(process.cwd(), 'src', 'repo-search', 'agent-loop-adapter.ts'), 'utf8');
  const summaryAdapter = fs.readFileSync(path.join(process.cwd(), 'src', 'summary', 'planner', 'agent-loop-adapter.ts'), 'utf8');

  for (const className of [
    'RepoSearchPromptAdapter',
    'RepoSearchActionAdapter',
    'RepoSearchToolAdapter',
    'RepoSearchResultAssembler',
    'RepoSearchPlannerModelClient',
  ]) {
    assert.match(repoAdapter, new RegExp(`class\\s+${className}\\b`, 'u'));
  }

  for (const className of [
    'SummaryPlannerPromptAdapter',
    'SummaryPlannerActionAdapter',
    'SummaryPlannerToolAdapter',
    'SummaryPlannerResultAssembler',
    'SummaryPlannerModelClient',
  ]) {
    assert.match(summaryAdapter, new RegExp(`class\\s+${className}\\b`, 'u'));
  }
});

test('AgentLoop does not maintain a second transcript or dead observers', () => {
  const agentLoopText = fs.readFileSync(path.join(process.cwd(), 'src', 'agent-loop', 'agent-loop.ts'), 'utf8');
  const typeText = fs.readFileSync(path.join(process.cwd(), 'src', 'agent-loop', 'types.ts'), 'utf8');
  const repoAdapter = fs.readFileSync(path.join(process.cwd(), 'src', 'repo-search', 'agent-loop-adapter.ts'), 'utf8');
  const summaryAdapter = fs.readFileSync(path.join(process.cwd(), 'src', 'summary', 'planner', 'agent-loop-adapter.ts'), 'utf8');
  const combined = [agentLoopText, typeText, repoAdapter, summaryAdapter].join('\n');

  assert.equal(/this\.messages|private\s+readonly\s+messages/u.test(agentLoopText), false);
  assert.equal(/buildInitialMessages|buildInvalidResponseMessage|buildForcedFinishMessage/u.test(combined), false);
  assert.equal(/AgentLoopObserver|observer\s*\?:|onTurnStart|onModelResponse|onToolResult/u.test(combined), false);
});

test('AgentLoop does not expose unused finish-evaluation fields or result reasons', () => {
  const typeText = fs.readFileSync(path.join(process.cwd(), 'src', 'agent-loop', 'types.ts'), 'utf8');

  assert.equal(/AgentLoopFinishEvaluation[\s\S]*?\bmessage\s*:/u.test(typeText), false);
  assert.equal(/'forced_finish'/u.test(typeText), false);
});

test('repo-search loop carries planner response through AgentLoop context', () => {
  const taskLoopText = fs.readFileSync(path.join(process.cwd(), 'src', 'repo-search', 'engine', 'task-loop.ts'), 'utf8');
  const adapterText = fs.readFileSync(path.join(process.cwd(), 'src', 'repo-search', 'agent-loop-adapter.ts'), 'utf8');

  assert.equal(/lastPlannerResponse|lastResolvedTokens|fromNormalizedResponse/u.test(taskLoopText), false);
  assert.equal(/class\s+RepoSearchPlannerClient\b/u.test(adapterText), false);
  assert.equal(/\bgetMessages\(\)|\bgetToolDefinitions\(\)|PlannerActionResponse/u.test(adapterText), false);
  assert.equal(/Math\.min\(\s*index\s*,\s*actions\.length\s*-\s*1\s*\)/u.test(taskLoopText), false);
});

test('summary planner does not use fake model responses or no-op loop plumbing', () => {
  const modeText = fs.readFileSync(path.join(process.cwd(), 'src', 'summary', 'planner', 'mode.ts'), 'utf8');
  const adapterText = fs.readFileSync(path.join(process.cwd(), 'src', 'summary', 'planner', 'agent-loop-adapter.ts'), 'utf8');

  assert.equal(/buildControlResponse|stopBeforeModel|raw\.outcome/u.test(modeText), false);
  assert.equal(/lastProviderResponse/u.test(modeText), false);
  assert.equal(/SummaryPlannerObserver|_allowedToolNames|\bgetMessages\(\)|\bgetToolDefinitions\(\)|unknown\[\]/u.test(adapterText), false);
});

test('status-server chat does not synthesize private replay tool-call protocol names', () => {
  const chatPath = path.join(process.cwd(), 'src', 'status-server', 'chat.ts');
  const text = fs.readFileSync(chatPath, 'utf8');

  assert.equal(/persisted_tool_call/u.test(text), false);
  assert.equal(/function\s+buildReplayToolCall\(/u.test(text), false);
});
