import test from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

import { parsePlannerAction, requestPlannerAction } from '../src/repo-search/planner-protocol.js';

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
      { tool_name: 'run_repo_cmd', args: { command: 'rg -n "plan" src' } },
      { tool_name: 'run_repo_cmd', args: { command: 'rg -n "repo-search" src' } },
    ],
  }));

  assert.deepEqual(action, {
    action: 'tool_batch',
    tool_calls: [
      { tool_name: 'run_repo_cmd', args: { command: 'rg -n "plan" src' } },
      { tool_name: 'run_repo_cmd', args: { command: 'rg -n "repo-search" src' } },
    ],
  });
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
                  name: 'run_repo_cmd',
                  arguments: '{"command":"rg -n \\"plan\\" src"}',
                },
              },
              {
                id: 'call_2',
                type: 'function',
                function: {
                  name: 'run_repo_cmd',
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
        { tool_name: 'run_repo_cmd', args: { command: 'rg -n "plan" src' } },
        { tool_name: 'run_repo_cmd', args: { command: 'rg -n "repo-search" src' } },
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
    res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"run_repo_cmd","arguments":"{\\"command\\":\\"rg -n \\\\\\"plan\\\\\\" src\\"}"}},{"index":1,"function":{"name":"run_repo_cmd","arguments":"{\\"command\\":\\"rg -n \\\\\\"repo-search\\\\\\" src\\"}"}}]}}]}\n\n');
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
        { tool_name: 'run_repo_cmd', args: { command: 'rg -n "plan" src' } },
        { tool_name: 'run_repo_cmd', args: { command: 'rg -n "repo-search" src' } },
      ],
    });
  });
});
