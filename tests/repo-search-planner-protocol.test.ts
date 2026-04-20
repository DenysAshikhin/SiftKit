import test from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  getRepoSearchToolNames,
  parsePlannerAction,
  requestPlannerAction,
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

test('parsePlannerAction parses tool batches', () => {
  const action = parsePlannerAction(JSON.stringify({
    action: 'tool_batch',
    tool_calls: [
      { tool_name: 'repo_rg', args: { command: 'rg -n "plan" src' } },
      { tool_name: 'repo_rg', args: { command: 'rg -n "repo-search" src' } },
    ],
  }));

  assert.deepEqual(action, {
    action: 'tool_batch',
    tool_calls: [
      { tool_name: 'repo_rg', args: { command: 'rg -n "plan" src' } },
      { tool_name: 'repo_rg', args: { command: 'rg -n "repo-search" src' } },
    ],
  });
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

test('requestPlannerAction reconstructs a tool batch from non-streaming multi-tool responses', async () => {
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
    const result = await requestPlannerAction({
      baseUrl,
      model: 'mock-model',
      messages: [{ role: 'user', content: 'find plan and repo-search' }],
      timeoutMs: 5000,
      requestMaxTokens: 512,
    });

    assert.equal(result.mockExhausted, false);
    assert.deepEqual(parsePlannerAction(result.text), {
      action: 'tool_batch',
      tool_calls: [
        { tool_name: 'repo_rg', args: { command: 'rg -n "plan" src' } },
        { tool_name: 'repo_rg', args: { command: 'rg -n "repo-search" src' } },
      ],
    });
  });
});

test('requestPlannerAction reconstructs a tool batch from streaming multi-tool responses', async () => {
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
    const result = await requestPlannerAction({
      baseUrl,
      model: 'mock-model',
      messages: [{ role: 'user', content: 'find plan and repo-search' }],
      timeoutMs: 5000,
      requestMaxTokens: 512,
      stream: true,
    });

    assert.deepEqual(parsePlannerAction(result.text), {
      action: 'tool_batch',
      tool_calls: [
        { tool_name: 'repo_rg', args: { command: 'rg -n "plan" src' } },
        { tool_name: 'repo_rg', args: { command: 'rg -n "repo-search" src' } },
      ],
    });
  });
});

test('requestPlannerAction reports prompt-eval and generation durations for streaming responses', async () => {
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
        res.write('data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":30,"completion_tokens":4,"completion_tokens_details":{"reasoning_tokens":6},"prompt_tokens_details":{"cached_tokens":20}}}\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
      }, 20);
    }, 20);
  }, async (baseUrl) => {
    const result = await requestPlannerAction({
      baseUrl,
      model: 'mock-model',
      messages: [{ role: 'user', content: 'finish' }],
      timeoutMs: 5000,
      requestMaxTokens: 512,
      stream: true,
    });

    assert.equal(result.promptEvalTokens, 10);
    assert.equal(result.completionTokens, 4);
    assert.equal(result.usageThinkingTokens, 6);
    assert.equal(Number.isFinite(Number(result.promptEvalDurationMs)), true);
    assert.equal(Number.isFinite(Number(result.generationDurationMs)), true);
    assert.ok(Number(result.promptEvalDurationMs) >= 10);
    assert.ok(Number(result.generationDurationMs) >= 10);
  });
});

test('requestPlannerAction sends json_schema response_format with tools and no grammar', async () => {
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
    await requestPlannerAction({
      baseUrl,
      model: 'mock-model',
      messages: [{ role: 'user', content: 'find plan and repo-search' }],
      timeoutMs: 5000,
      requestMaxTokens: 512,
    });

    const captured = capturedBody as Record<string, any>;
    assert.equal(captured?.response_format?.type, 'json_schema');
    assert.equal(Array.isArray(captured?.tools), true);
    assert.equal(captured?.parallel_tool_calls, true);
    assert.equal('grammar' in (captured || {}), false);
  });
});

test('requestPlannerAction assembles planner schema dynamically from provided tool definitions', async () => {
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
    await requestPlannerAction({
      baseUrl,
      model: 'mock-model',
      messages: [{ role: 'user', content: 'find symbol' }],
      timeoutMs: 5000,
      requestMaxTokens: 512,
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
    assert.equal(captured?.tools?.[0]?.function?.name, 'search_symbol');
  });
});

test('requestPlannerAction hard-fails on json_schema rejection without fallback retry', async () => {
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
      () => requestPlannerAction({
        baseUrl,
        model: 'mock-model',
        messages: [{ role: 'user', content: 'find plan and repo-search' }],
        timeoutMs: 5000,
        requestMaxTokens: 512,
      }),
      /HTTP 400/u,
    );
    assert.equal(requestCount, 1);
  });
});
