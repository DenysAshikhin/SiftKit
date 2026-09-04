import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

type SourceFile = {
  filePath: string;
  text: string;
};

const ENGINE_ENDPOINT_LITERAL_ALLOWLIST = new Set<string>([
  'src/llm-protocol/inference-client.ts',
  'src/status-server/managed-tabby.ts',
  'src/status-server/tabby-model-client.ts',
  'src/status-server/routes/inference-passthrough.ts',
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

test('inference HTTP request construction lives only in InferenceClient', () => {
  const offenders = listTypeScriptFiles(path.join(process.cwd(), 'src'))
    .filter((file) => !ENGINE_ENDPOINT_LITERAL_ALLOWLIST.has(file.filePath))
    .filter((file) => /\/v1\/chat\/completions|\/tokenize|\/v1\/models/u.test(file.text))
    .map((file) => file.filePath)
    .sort();

  assert.deepEqual(offenders, []);
});

test('tool-call protocol parsing has one implementation', () => {
  const offenders = listTypeScriptFiles(path.join(process.cwd(), 'src'))
    .filter((file) => file.filePath !== 'src/llm-protocol/inference-client.ts')
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

test('native repo-tool arguments have one runtime-schema implementation', () => {
  const modelJsonPath = path.join(process.cwd(), 'src', 'lib', 'model-json.ts');
  const canonicalProtocolPath = path.join(process.cwd(), 'src', 'repo-search', 'repo-tool-arguments.ts');
  const modelJsonText = fs.readFileSync(modelJsonPath, 'utf8');
  const canonicalProtocolText = fs.readFileSync(canonicalProtocolPath, 'utf8');

  assert.doesNotMatch(modelJsonText, /REPO_TOOL_ARG_SPECS/u);
  assert.doesNotMatch(modelJsonText, /argSpec\.requiredText|argSpec\.verbatimText|rawArgs\.outputMode/u);
  assert.doesNotMatch(modelJsonText, /RepoNativeToolCallSchema/u);
  assert.match(canonicalProtocolText, /RepoNativeToolCallSchema/u);
});

test('native repo-tool execution consumes canonical typed calls', () => {
  const repoTools = fs.readFileSync(
    path.join(process.cwd(), 'src', 'repo-search', 'engine', 'repo-tools.ts'),
    'utf8',
  );
  const processor = fs.readFileSync(
    path.join(process.cwd(), 'src', 'repo-search', 'engine', 'tool-action-processor.ts'),
    'utf8',
  );

  assert.match(repoTools, /executeRepoTool\(\s*call:\s*RepoNativeToolCall/u);
  assert.doesNotMatch(repoTools, /executeRepoTool\(\s*toolName:\s*string/u);
  assert.match(processor, /RepoNativeToolCallSchema/u);
});

test('repo-agent runtime behavior flows through one profile', () => {
  const runtimePaths = [
    ['src', 'repo-search', 'engine.ts'],
    ['src', 'repo-search', 'engine', 'task-loop-support.ts'],
    ['src', 'repo-search', 'engine', 'task-loop.ts'],
    ['src', 'repo-search', 'engine', 'prompt-preparer.ts'],
    ['src', 'repo-search', 'engine', 'tool-action-processor.ts'],
    ['src', 'repo-search', 'engine', 'repo-tools.ts'],
  ];
  const runtimeTexts = runtimePaths.map((parts) => fs.readFileSync(
    path.join(process.cwd(), ...parts),
    'utf8',
  ));
  const execute = fs.readFileSync(
    path.join(process.cwd(), 'src', 'repo-search', 'execute.ts'),
    'utf8',
  );
  const engine = runtimeTexts[0] ?? '';
  const taskLoopSupport = runtimeTexts[1] ?? '';
  const taskLoop = runtimeTexts[2] ?? '';
  const validationPolicy = fs.readFileSync(
    path.join(
      process.cwd(),
      'src',
      'repo-search',
      'engine',
      'validation-command-output-policy.ts',
    ),
    'utf8',
  );
  const runtimeProfile = fs.readFileSync(
    path.join(process.cwd(), 'src', 'repo-search', 'engine', 'runtime-profile.ts'),
    'utf8',
  );

  for (const text of runtimeTexts) {
    assert.doesNotMatch(text, /validationCommandOutputLineLimit/u);
  }
  assert.doesNotMatch(execute, /validationCommandOutputLineLimit|REPO_AGENT_DEFAULT_MAX_TURNS/u);
  assert.doesNotMatch(engine, /loopKind\?:/u);
  assert.doesNotMatch(taskLoopSupport, /loopKind\?:/u);
  assert.doesNotMatch(taskLoop, /options\.loopKind/u);
  assert.doesNotMatch(execute, /\bloopKind\s*:/u);
  assert.doesNotMatch(validationPolicy, /shapeRunOutput|ExecutableRunFullOutputDecision/u);
  assert.doesNotMatch(runtimeTexts[4] ?? '', /RunFullOutputGate|RUN_FULL_DOWNGRADE_NOTICE|isValidationCommand/u);
  assert.match(runtimeProfile, /RunFullOutputGate/u);
  assert.match(runtimeProfile, /RUN_FULL_DOWNGRADE_NOTICE/u);
  assert.match(runtimeTexts.join('\n'), /RepoSearchRuntimeProfile/u);
});

test('run planner metadata references canonical runtime exports', () => {
  // Run-tool provider metadata is generated from the canonical Zod argument schema, so the
  // runtime constants must be referenced there, and the planner registry must hold no
  // hand-written parameter schema.
  const toolArguments = fs.readFileSync(
    path.join(process.cwd(), 'src', 'repo-search', 'repo-tool-arguments.ts'),
    'utf8',
  );
  const planner = fs.readFileSync(
    path.join(process.cwd(), 'src', 'repo-search', 'planner-protocol.ts'),
    'utf8',
  );

  assert.match(toolArguments, /RUN_OUTPUT_MODES/u);
  assert.match(toolArguments, /REPO_AGENT_VALIDATION_OUTPUT_LINE_LIMIT/u);
  for (const source of [toolArguments, planner]) {
    assert.doesNotMatch(source, /enum:\s*\['auto',\s*'full'\]/u);
    assert.doesNotMatch(source, /final 50 lines/u);
  }
  assert.doesNotMatch(planner, /parameters:\s*\{/u);
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
