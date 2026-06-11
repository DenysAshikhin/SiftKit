import test from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

import { ModelJson } from '../src/lib/model-json.js';
import {
  getRepoSearchToolNames,
  getRepoSearchToolNamesForParsing,
  requestRepoSearchPlannerProtocolAction,
  resolveRepoSearchPlannerToolDefinitions,
} from '../src/repo-search/planner-protocol.js';

async function withServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
  fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', (error?: Error) => (error ? reject(error) : resolve()));
  });
  try {
    const address = server.address() as AddressInfo;
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

test('ModelJson parses repo-search tool batches', () => {
  const action = ModelJson.parseRepoSearchPlannerAction(JSON.stringify({
    action: 'tool_batch',
    calls: [
      { action: 'repo_rg', command: 'rg -n "plan" src' },
      { action: 'repo_rg', command: 'rg -n "repo-search" src' },
    ],
  }), { allowedToolNames: getRepoSearchToolNamesForParsing() });

  assert.deepEqual(action, {
    action: 'tool_batch',
    tool_calls: [
      { tool_name: 'repo_rg', args: { command: 'rg -n "plan" src' } },
      { tool_name: 'repo_rg', args: { command: 'rg -n "repo-search" src' } },
    ],
  });
});

test('resolveRepoSearchPlannerToolDefinitions only emits web tool schemas when explicitly allowed', () => {
  const withoutWeb = resolveRepoSearchPlannerToolDefinitions(['repo_rg']);
  assert.equal(withoutWeb.some((tool) => tool.function.name === 'web_search'), false);
  assert.equal(withoutWeb.some((tool) => tool.function.name === 'web_fetch'), false);

  const withWeb = resolveRepoSearchPlannerToolDefinitions(['repo_rg', 'web_search', 'web_fetch']);
  assert.equal(withWeb.some((tool) => tool.function.name === 'web_search'), true);
  assert.equal(withWeb.some((tool) => tool.function.name === 'web_fetch'), true);
  const webSearch = withWeb.find((tool) => tool.function.name === 'web_search');
  assert.deepEqual(webSearch?.function?.parameters?.required, ['query']);
});

test('getRepoSearchToolNamesForParsing excludes web tools so forged web actions are rejected by default', () => {
  const names = getRepoSearchToolNamesForParsing();
  assert.equal(names.includes('web_search'), false);
  assert.equal(names.includes('web_fetch'), false);
});

test('ModelJson rejects web tools unless allowed and normalizes their args when allowed', () => {
  assert.throws(
    () => ModelJson.parseRepoSearchPlannerAction('{"action":"web_search","query":"x"}', { allowedToolNames: ['repo_rg'] }),
    /unknown|invalid/i,
  );

  assert.deepEqual(
    ModelJson.parseRepoSearchPlannerAction('{"action":"web_search","query":"x"}', { allowedToolNames: ['web_search'] }),
    { action: 'tool', tool_name: 'web_search', args: { query: 'x' } },
  );
  assert.deepEqual(
    ModelJson.parseRepoSearchPlannerAction('{"action":"web_search","query":"x","timeFilter":"week"}', { allowedToolNames: ['web_search'] }),
    { action: 'tool', tool_name: 'web_search', args: { query: 'x', timeFilter: 'week' } },
  );
  assert.deepEqual(
    ModelJson.parseRepoSearchPlannerAction('{"action":"web_fetch","url":"https://example.com"}', { allowedToolNames: ['web_fetch'] }),
    { action: 'tool', tool_name: 'web_fetch', args: { url: 'https://example.com' } },
  );
});

test('repo-search tool registry exposes native read/list tools and drops redundant legacy ones', () => {
  const toolNames = getRepoSearchToolNames().sort();
  assert.equal(toolNames.includes('repo_read_file'), true);
  assert.equal(toolNames.includes('repo_list_files'), true);
  assert.equal(toolNames.includes('repo_get_content'), false);
  assert.equal(toolNames.includes('repo_get_childitem'), false);
  assert.equal(toolNames.includes('repo_select_string'), false);
  assert.equal(toolNames.includes('repo_pwd'), false);
  assert.equal(toolNames.includes('repo_ls'), false);

  const definitions = resolveRepoSearchPlannerToolDefinitions();
  const readFile = definitions.find((tool) => tool.function.name === 'repo_read_file');
  assert.deepEqual(readFile?.function?.parameters?.required, ['path']);
  assert.equal(readFile?.function?.parameters?.properties?.startLine?.type, 'integer');
  assert.equal(readFile?.function?.parameters?.properties?.endLine?.type, 'integer');

  const listFiles = definitions.find((tool) => tool.function.name === 'repo_list_files');
  assert.deepEqual(listFiles?.function?.parameters?.required, []);
  assert.equal(listFiles?.function?.parameters?.properties?.path?.type, 'string');
  assert.equal(listFiles?.function?.parameters?.properties?.glob?.type, 'string');
  assert.equal(listFiles?.function?.parameters?.properties?.recurse?.type, 'boolean');
});

test('requestRepoSearchPlannerProtocolAction reconstructs a tool batch from non-streaming multi-tool responses', async () => {
  await withServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      res.statusCode = 404;
      res.end();
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      choices: [
        {
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: {
                  name: 'repo_rg',
                  arguments: '{"command":"rg -n \\"plan\\" src"}',
                },
              },
              {
                id: 'call_2',
                type: 'function',
                function: {
                  name: 'repo_rg',
                  arguments: '{"command":"rg -n \\"repo-search\\" src"}',
                },
              },
            ],
          },
        },
      ],
    }));
  }, async (baseUrl) => {
    const result = await requestRepoSearchPlannerProtocolAction({
      baseUrl,
      model: 'mock-model',
      messages: [{ role: 'user', content: 'find plan and repo-search' }],
      timeoutMs: 5000,
      maxTokens: 512,
    });

    assert.equal(result.mockExhausted, false);
    assert.deepEqual(ModelJson.parseRepoSearchPlannerAction(result.text, { allowedToolNames: getRepoSearchToolNamesForParsing() }), {
      action: 'tool_batch',
      tool_calls: [
        { tool_name: 'repo_rg', args: { command: 'rg -n "plan" src' } },
        { tool_name: 'repo_rg', args: { command: 'rg -n "repo-search" src' } },
      ],
    });
  });
});

test('requestRepoSearchPlannerProtocolAction reconstructs a tool batch from streaming multi-tool responses', async () => {
  await withServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      res.statusCode = 404;
      res.end();
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"repo_rg","arguments":"{\\"command\\":\\"rg -n \\\\\\"plan\\\\\\" src\\"}"}},{"index":1,"function":{"name":"repo_rg","arguments":"{\\"command\\":\\"rg -n \\\\\\"repo-search\\\\\\" src\\"}"}}]}}]}\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
  }, async (baseUrl) => {
    const result = await requestRepoSearchPlannerProtocolAction({
      baseUrl,
      model: 'mock-model',
      messages: [{ role: 'user', content: 'find plan and repo-search' }],
      timeoutMs: 5000,
      maxTokens: 512,
      stream: true,
    });

    assert.deepEqual(ModelJson.parseRepoSearchPlannerAction(result.text, { allowedToolNames: getRepoSearchToolNamesForParsing() }), {
      action: 'tool_batch',
      tool_calls: [
        { tool_name: 'repo_rg', args: { command: 'rg -n "plan" src' } },
        { tool_name: 'repo_rg', args: { command: 'rg -n "repo-search" src' } },
      ],
    });
  });
});

test('requestRepoSearchPlannerProtocolAction stops streamed reasoning after a complete planner action', async () => {
  const actionText = '{"action":"tool_batch","calls":[{"action":"repo_rg","command":"rg -n \\"planner\\" src"}]}';
  let writeCount = 0;

  await withServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      res.statusCode = 404;
      res.end();
      return;
    }
    req.resume();
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: actionText } }] })}\n\n`);
    writeCount += 1;
    const interval = setInterval(() => {
      writeCount += 1;
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: '}' } }] })}\n\n`);
    }, 25);
    res.on('close', () => clearInterval(interval));
  }, async (baseUrl) => {
    const result = await requestRepoSearchPlannerProtocolAction({
      baseUrl,
      model: 'mock-model',
      messages: [{ role: 'user', content: 'find planner' }],
      timeoutMs: 2000,
      maxTokens: 512,
      stream: true,
    });

    assert.equal(result.text, actionText);
    assert.equal(result.thinkingText, '');
    assert.equal(writeCount, 1);
  });
});

test('requestRepoSearchPlannerProtocolAction stops streamed content when recent tokens repeat in long output', async () => {
  const repeatedTail = '</arg_value>'.repeat(64);
  const longPrefix = Array.from({ length: 101 }, (_, index) => `anchor-${index}`).join(' ');
  const events: Array<Record<string, unknown> & { kind: string }> = [];

  await withServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      res.statusCode = 404;
      res.end();
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `${longPrefix} ${repeatedTail}` } }] })}\n\n`);
  }, async (baseUrl) => {
    const result = await requestRepoSearchPlannerProtocolAction({
      baseUrl,
      model: 'mock-model',
      messages: [{ role: 'user', content: 'find planner' }],
      timeoutMs: 2000,
      maxTokens: 512,
      stream: true,
      logger: {
        write(event: Record<string, unknown> & { kind: string }) {
          events.push(event);
        },
      },
    });

    const doneEvent = events.find((event) => event.kind === 'provider_request_done');
    assert.match(String(doneEvent?.earlyTerminationReason || ''), /recent planner content tokens repeated/u);
    assert.match(result.text, /SiftKit stopped the planner stream early/u);
    assert.doesNotMatch(result.text, new RegExp(repeatedTail, 'u'));
  });
});

test('requestRepoSearchPlannerProtocolAction does not stop streamed content for a short repeated suffix', async () => {
  const repeatedTail = '</arg_value>'.repeat(10);
  const longPrefix = Array.from({ length: 101 }, (_, index) => `anchor-${index}`).join(' ');
  const streamedText = `${longPrefix} ${repeatedTail}`;
  const events: Array<Record<string, unknown> & { kind: string }> = [];

  await withServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      res.statusCode = 404;
      res.end();
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: streamedText } }] })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  }, async (baseUrl) => {
    const result = await requestRepoSearchPlannerProtocolAction({
      baseUrl,
      model: 'mock-model',
      messages: [{ role: 'user', content: 'find planner' }],
      timeoutMs: 2000,
      maxTokens: 512,
      stream: true,
      logger: {
        write(event: Record<string, unknown> & { kind: string }) {
          events.push(event);
        },
      },
    });

    const doneEvent = events.find((event) => event.kind === 'provider_request_done');
    assert.equal(Object.prototype.hasOwnProperty.call(doneEvent || {}, 'earlyTerminationReason'), false);
    assert.equal(result.text, streamedText);
  });
});

test('requestRepoSearchPlannerProtocolAction uses llama timings from the final streaming chunk when usage is absent', async () => {
  await withServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      res.statusCode = 404;
      res.end();
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    setTimeout(() => {
      res.write('data: {"choices":[{"delta":{"content":"{\\"action\\":\\"finish\\",\\"output\\":\\"done\\"}"}}]}\n\n');
      setTimeout(() => {
        res.write('data: {"choices":[{"delta":{}}],"timings":{"cache_n":20,"prompt_n":10,"prompt_ms":30.5,"prompt_per_second":327.86,"predicted_n":4,"predicted_ms":18.75,"predicted_per_second":213.33},"__verbose":{"tokens_predicted":4,"timings":{"cache_n":20,"prompt_n":10,"prompt_ms":30.5,"prompt_per_second":327.86,"predicted_n":4,"predicted_ms":18.75,"predicted_per_second":213.33}}}\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
      }, 20);
    }, 20);
  }, async (baseUrl) => {
    const result = await requestRepoSearchPlannerProtocolAction({
      baseUrl,
      model: 'mock-model',
      messages: [{ role: 'user', content: 'finish' }],
      timeoutMs: 5000,
      maxTokens: 512,
      stream: true,
    });

    assert.equal(result.promptEvalTokens, 10);
    assert.equal(result.completionTokens, 4);
    assert.equal(result.usageThinkingTokens, null);
    assert.equal(result.promptEvalDurationMs, 30.5);
    assert.equal(result.generationDurationMs, 18.75);
  });
});

test('requestRepoSearchPlannerProtocolAction aborts an in-flight streaming request', async () => {
  await withServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      res.statusCode = 404;
      res.end();
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('data: {"choices":[{"delta":{"content":"{\\"action\\":\\"finish"}}]}\n\n');
  }, async (baseUrl) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('Repo search prompt exceeded 20 ms. Please try again.')), 20);
    try {
      await assert.rejects(
        () => requestRepoSearchPlannerProtocolAction({
          baseUrl,
          model: 'mock-model',
          messages: [{ role: 'user', content: 'finish slowly' }],
          timeoutMs: 5000,
          maxTokens: 512,
          stream: true,
          abortSignal: controller.signal,
        }),
        /Repo search prompt exceeded 20 ms\. Please try again\./u,
      );
    } finally {
      clearTimeout(timer);
    }
  });
});

test('requestRepoSearchPlannerProtocolAction sends json_schema response_format without native tools or grammar', async () => {
  let capturedBody: Record<string, unknown> | null = null;
  await withServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      res.statusCode = 404;
      res.end();
      return;
    }
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      capturedBody = JSON.parse(body || '{}');
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        choices: [{ message: { content: '{"action":"finish","output":"done"}' } }],
      }));
    });
  }, async (baseUrl) => {
    await requestRepoSearchPlannerProtocolAction({
      baseUrl,
      model: 'mock-model',
      messages: [{ role: 'user', content: 'find plan and repo-search' }],
      timeoutMs: 5000,
      maxTokens: 512,
    });

    const captured = capturedBody as Record<string, any>;
    assert.equal(captured?.response_format?.type, 'json_schema');
    assert.equal('tools' in (captured || {}), false);
    assert.equal('parallel_tool_calls' in (captured || {}), false);
    assert.equal('grammar' in (captured || {}), false);
  });
});

test('requestRepoSearchPlannerProtocolAction assembles planner schema dynamically from provided tool definitions', async () => {
  let capturedBody: Record<string, unknown> | null = null;
  await withServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      res.statusCode = 404;
      res.end();
      return;
    }
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      capturedBody = JSON.parse(body || '{}');
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        choices: [{ message: { content: '{"action":"finish","output":"done"}' } }],
      }));
    });
  }, async (baseUrl) => {
    await requestRepoSearchPlannerProtocolAction({
      baseUrl,
      model: 'mock-model',
      messages: [{ role: 'user', content: 'find symbol' }],
      timeoutMs: 5000,
      maxTokens: 512,
      toolDefinitions: [{
        type: 'function',
        function: {
          name: 'search_symbol',
          description: 'search symbols',
          parameters: {
            type: 'object',
            properties: { symbol: { type: 'string' } },
            required: ['symbol'],
          },
        },
      }],
    });

    const captured = capturedBody as Record<string, any>;
    const schemaText = JSON.stringify(captured?.response_format || {});
    assert.match(schemaText, /search_symbol/u);
    assert.doesNotMatch(schemaText, /run_repo_cmd/u);
    assert.doesNotMatch(schemaText, /tool_name/u);
    assert.equal('tools' in (captured || {}), false);
  });
});

test('requestRepoSearchPlannerProtocolAction hard-fails on json_schema rejection without fallback retry', async () => {
  let requestCount = 0;
  await withServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      res.statusCode = 404;
      res.end();
      return;
    }
    requestCount += 1;
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'response_format json_schema unsupported' } }));
  }, async (baseUrl) => {
    await assert.rejects(
      () => requestRepoSearchPlannerProtocolAction({
        baseUrl,
        model: 'mock-model',
        messages: [{ role: 'user', content: 'find plan and repo-search' }],
        timeoutMs: 5000,
        maxTokens: 512,
      }),
      /HTTP 400/u,
    );
    assert.equal(requestCount, 1);
  });
});
