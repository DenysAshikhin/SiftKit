import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { JsonValueSchema, type JsonValue } from '../src/lib/json-types.js';
import { TabbyModelClient } from '../src/status-server/tabby-model-client.js';
import { getAddressInfo } from './helpers/dashboard-http.js';

test('Tabby model client loads and unloads through validated lifecycle packets', async () => {
  let residentModel: string | null = null;
  const loadBodies: JsonValue[] = [];
  const server = http.createServer((request, response) => {
    if (request.method === 'POST' && request.url === '/v1/model/load') {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk) => { body += chunk; });
      request.on('end', () => {
        const parsed = JsonValueSchema.parse(JSON.parse(body));
        loadBodies.push(parsed);
        residentModel = 'model-a';
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end('data: {"model_type":"model","module":1,"modules":1,"status":"finished"}\n\n');
      });
      return;
    }
    if (request.method === 'POST' && request.url === '/v1/model/unload') {
      residentModel = null;
      response.statusCode = 200;
      response.end();
      return;
    }
    if (request.method === 'GET' && request.url === '/v1/model') {
      if (residentModel === null) {
        response.statusCode = 400;
        response.end('{"detail":"Model is not loaded"}');
        return;
      }
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ id: residentModel }));
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${getAddressInfo(server).port}`;
  const client = new TabbyModelClient();
  try {
    await client.load(baseUrl, {
      model_name: 'model-a',
      max_seq_len: 8192,
      cache_size: 8192,
      cache_mode: 'FP16',
    }, 1_000);
    assert.deepEqual(await client.listModels(baseUrl, 1_000), ['model-a']);
    assert.deepEqual(loadBodies, [{
      model_name: 'model-a',
      max_seq_len: 8192,
      cache_size: 8192,
      cache_mode: 'FP16',
    }]);
    await client.unload(baseUrl, 1_000);
    assert.deepEqual(await client.listModels(baseUrl, 1_000), []);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('Tabby model client rejects a load stream without terminal completion', async () => {
  const server = http.createServer((request, response) => {
    if (request.url === '/v1/model/load') {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end('data: {"model_type":"model","module":1,"modules":2,"status":"processing"}\n\n');
      return;
    }
    response.statusCode = 400;
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${getAddressInfo(server).port}`;
  try {
    await assert.rejects(new TabbyModelClient().load(baseUrl, {
      model_name: 'model-a',
      max_seq_len: 8192,
      cache_size: 8192,
      cache_mode: 'FP16',
    }, 1_000), /without a terminal finished event/u);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
