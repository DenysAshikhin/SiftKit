import test from 'node:test';
import assert from 'node:assert/strict';

import { getActiveModelPreset } from '../src/config/getters.js';
import { startStubStatusServer } from './_runtime-helpers.js';
import { DashboardTestServer } from './helpers/dashboard-server-fixture.js';
import { asObject, asObjectArray, requestJson, requestSse, type Dict } from './helpers/dashboard-http.js';

// Every chat route merges two speculative-token sources: the managed llama startup-log
// tracker wins, and the run's own usage/scorecard totals fill in when the tracker has
// nothing. tests/status-server-speculative-metrics.test.ts pins the tracker half; these
// E2Es pin the fallback half on all five routes that persist it, which only runs when no
// managed llama process is tracked (DashboardTestServer boots with disableManagedLlamaStartup).
const CHAT_PROMPT = 'What is 2+2?';
const CHAT_ANSWER = '4';
const MOCK_FINISH_RESPONSE = `{"action":"finish","output":"${CHAT_ANSWER}"}`;
const MOCK_TOOL_RESPONSE = '{"action":"git","command":"git grep -n \\"test\\" ."}';
const MOCK_TOOL_COMMAND = 'git grep -n "test" .';

const BACKEND_USAGE = {
  prompt_tokens: 123,
  prompt_tokens_details: { cached_tokens: 100 },
  completion_tokens: 45,
  total_tokens: 168,
  draft_accepted_tokens: 36,
  draft_rejected_tokens: 9,
};
const EXPECTED_SPECULATIVE_ACCEPTED_TOKENS = 36;
const EXPECTED_SPECULATIVE_GENERATED_TOKENS = 45;

function buildChatCompletion(content: string, withUsage: boolean) {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    choices: [{ index: 0, message: { role: 'assistant', content } }],
    ...(withUsage ? { usage: BACKEND_USAGE } : {}),
  };
}

/** The plan and repo-search loops only accept a finish after a tool turn. */
function buildAgentTurnBody(repoRoot: string): string {
  return JSON.stringify({
    content: 'Find tests',
    repoRoot,
    maxTurns: 2,
    mockCommandResults: {
      [MOCK_TOOL_COMMAND]: { exitCode: 0, stdout: 'tests/example.test.ts:1:test()', stderr: '' },
    },
  });
}

function assertFallbackSpeculativeTokens(session: Dict): void {
  const assistantMessages = asObjectArray(session.messages).filter((message) => message.role === 'assistant');
  const latest = assistantMessages[assistantMessages.length - 1];
  assert.ok(latest, 'the turn must persist an assistant message');
  assert.deepEqual({
    speculativeAcceptedTokens: latest.speculativeAcceptedTokens,
    speculativeGeneratedTokens: latest.speculativeGeneratedTokens,
  }, {
    speculativeAcceptedTokens: EXPECTED_SPECULATIVE_ACCEPTED_TOKENS,
    speculativeGeneratedTokens: EXPECTED_SPECULATIVE_GENERATED_TOKENS,
  });
}

/**
 * A dashboard server whose active preset points at a stub backend reporting draft-token
 * counters, so the run's own totals carry speculative numbers while no managed llama is
 * tracked. Chat turns finish in one model call; plan and repo-search turns need a tool
 * turn first, and usage rides on the finishing call only so the scorecard total stays a
 * single contribution.
 */
class SpeculativeFallbackFixture {
  private constructor(
    private readonly backend: Awaited<ReturnType<typeof startStubStatusServer>>,
    private readonly server: DashboardTestServer,
    readonly tempRoot: string,
  ) {}

  static async startForChat(namePrefix: string): Promise<SpeculativeFallbackFixture> {
    return SpeculativeFallbackFixture.attach(namePrefix, await startStubStatusServer({
      tokenizeCharsPerToken: 4,
      chatResponse: () => buildChatCompletion(MOCK_FINISH_RESPONSE, true),
    }));
  }

  static async startForAgent(namePrefix: string): Promise<SpeculativeFallbackFixture> {
    return SpeculativeFallbackFixture.attach(namePrefix, await startStubStatusServer({
      tokenizeCharsPerToken: 4,
      chatResponse: (_promptText, _parsed, callIndex) => (callIndex === 0
        ? buildChatCompletion(MOCK_TOOL_RESPONSE, false)
        : buildChatCompletion(MOCK_FINISH_RESPONSE, callIndex === 1)),
    }));
  }

  private static async attach(
    namePrefix: string,
    backend: Awaited<ReturnType<typeof startStubStatusServer>>,
  ): Promise<SpeculativeFallbackFixture> {
    const backendModel = getActiveModelPreset(backend.state.config).Model;
    assert.ok(backendModel);
    const server = await DashboardTestServer.start(namePrefix, {
      baseUrl: `http://127.0.0.1:${backend.port}`,
      model: backendModel,
    });
    return new SpeculativeFallbackFixture(backend, server, server.tempRoot);
  }

  async createSession(title: string): Promise<string> {
    const created = await requestJson(`${this.server.baseUrl}/dashboard/chat/sessions`, {
      method: 'POST',
      body: JSON.stringify({ title }),
    });
    assert.equal(created.statusCode, 200, JSON.stringify(created.body));
    return String(asObject(created.body.session).id);
  }

  async postJsonTurn(sessionId: string, routeSuffix: string, body: string): Promise<Dict> {
    const response = await requestJson(
      `${this.server.baseUrl}/dashboard/chat/sessions/${sessionId}/${routeSuffix}`,
      { method: 'POST', timeoutMs: 30_000, body },
    );
    assert.equal(response.statusCode, 200, JSON.stringify(response.body));
    return asObject(response.body.session);
  }

  async postSseTurn(sessionId: string, routeSuffix: string, body: string): Promise<Dict> {
    const sse = await requestSse(
      `${this.server.baseUrl}/dashboard/chat/sessions/${sessionId}/${routeSuffix}`,
      { method: 'POST', timeoutMs: 30_000, body },
    );
    assert.equal(sse.statusCode, 200, JSON.stringify(sse.events));
    assert.equal(sse.events.some((event) => event.event === 'error'), false, JSON.stringify(sse.events));
    const done = sse.events.find((event) => event.event === 'done');
    return asObject(asObject(done?.payload).session);
  }

  async close(): Promise<void> {
    await this.server.close();
    await this.backend.close();
  }
}

test('a chat message persists usage speculative tokens when no managed llama tracker is running', async () => {
  const fixture = await SpeculativeFallbackFixture.startForChat('siftkit-chat-spec-fallback-');
  try {
    const sessionId = await fixture.createSession('spec-fallback');
    const session = await fixture.postJsonTurn(sessionId, 'messages', JSON.stringify({ content: CHAT_PROMPT }));
    assertFallbackSpeculativeTokens(session);
  } finally {
    await fixture.close();
  }
});

test('a streamed chat message persists usage speculative tokens when no managed llama tracker is running', async () => {
  const fixture = await SpeculativeFallbackFixture.startForChat('siftkit-chat-stream-spec-fallback-');
  try {
    const sessionId = await fixture.createSession('spec-fallback-stream');
    const session = await fixture.postSseTurn(sessionId, 'messages/stream', JSON.stringify({
      content: CHAT_PROMPT,
      webSearchOverride: 'off',
    }));
    assertFallbackSpeculativeTokens(session);
  } finally {
    await fixture.close();
  }
});

test('a plan turn persists scorecard speculative tokens when no managed llama tracker is running', async () => {
  const fixture = await SpeculativeFallbackFixture.startForAgent('siftkit-plan-spec-fallback-');
  try {
    const sessionId = await fixture.createSession('plan-spec-fallback');
    const session = await fixture.postJsonTurn(sessionId, 'plan', buildAgentTurnBody(fixture.tempRoot));
    assertFallbackSpeculativeTokens(session);
  } finally {
    await fixture.close();
  }
});

test('a streamed plan turn persists scorecard speculative tokens when no managed llama tracker is running', async () => {
  const fixture = await SpeculativeFallbackFixture.startForAgent('siftkit-plan-stream-spec-fallback-');
  try {
    const sessionId = await fixture.createSession('plan-stream-spec-fallback');
    const session = await fixture.postSseTurn(sessionId, 'plan/stream', buildAgentTurnBody(fixture.tempRoot));
    assertFallbackSpeculativeTokens(session);
  } finally {
    await fixture.close();
  }
});

test('a repo-search stream persists scorecard speculative tokens when no managed llama tracker is running', async () => {
  const fixture = await SpeculativeFallbackFixture.startForAgent('siftkit-repo-spec-fallback-');
  try {
    const sessionId = await fixture.createSession('repo-spec-fallback');
    const session = await fixture.postSseTurn(sessionId, 'repo-search/stream', buildAgentTurnBody(fixture.tempRoot));
    assertFallbackSpeculativeTokens(session);
  } finally {
    await fixture.close();
  }
});
