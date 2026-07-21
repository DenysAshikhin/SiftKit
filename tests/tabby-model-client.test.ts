import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { JsonValueSchema, type JsonValue } from '../src/lib/json-types.js';
import { TabbyModelClient } from '../src/status-server/tabby-model-client.js';
import { getAddressInfo } from './helpers/dashboard-http.js';
import { FakeTabbyModelState } from './helpers/tabby-fake.js';

test('Tabby model client loads and unloads through validated lifecycle packets', async () => {
  const model = new FakeTabbyModelState();
  const loadBodies: JsonValue[] = [];
  const authorizations: Array<string | null> = [];
  const server = http.createServer((request, response) => {
    authorizations.push(request.headers.authorization ?? null);
    if (request.method === 'GET' && request.url === '/v1/models') {
      response.setHeader('content-type', 'application/json');
      response.end('{"data":[]}');
      return;
    }
    if (request.method === 'POST' && request.url === '/v1/model/load') {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk) => { body += chunk; });
      request.on('end', () => {
        loadBodies.push(JsonValueSchema.parse(JSON.parse(body)));
        model.applyLoad(body);
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end('data: {"model_type":"model","module":1,"modules":1,"status":"finished"}\n\n');
      });
      return;
    }
    if (request.method === 'POST' && request.url === '/v1/model/unload') {
      model.clear();
      response.statusCode = 200;
      response.end();
      return;
    }
    if (request.method === 'GET' && request.url === '/v1/model') {
      model.respondCurrentModel(response);
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${getAddressInfo(server).port}`;
  const client = new TabbyModelClient('admin-secret');
  try {
    assert.equal(await client.isProcessReady(baseUrl, 1_000), true);
    await client.load(baseUrl, {
      model_name: 'model-a',
      max_seq_len: 8192,
      cache_size: 8192,
      cache_mode: 'FP16',
      chunk_size: 512,
    }, 1_000);
    assert.deepEqual(await client.getResidentModel(baseUrl, 1_000), {
      id: 'model-a',
      parameters: { max_seq_len: 8192, cache_size: 8192, chunk_size: 512 },
    });
    assert.deepEqual(loadBodies, [{
      model_name: 'model-a',
      max_seq_len: 8192,
      cache_size: 8192,
      cache_mode: 'FP16',
      chunk_size: 512,
    }]);
    await client.unload(baseUrl, 1_000);
    assert.equal(await client.getResidentModel(baseUrl, 1_000), null);
    assert.ok(authorizations.length > 0);
    assert.ok(authorizations.every((authorization) => authorization === 'Bearer admin-secret'));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('Tabby model client omits authorization when no admin key is configured', async () => {
  const authorizations: Array<string | null> = [];
  const server = http.createServer((request, response) => {
    authorizations.push(request.headers.authorization ?? null);
    if (request.url === '/v1/models') {
      response.setHeader('content-type', 'application/json');
      response.end('{"data":[]}');
      return;
    }
    response.statusCode = 503;
    response.end('No models are currently loaded');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${getAddressInfo(server).port}`;
  const client = new TabbyModelClient('');
  try {
    assert.equal(await client.isProcessReady(baseUrl, 1_000), true);
    assert.equal(await client.getResidentModel(baseUrl, 1_000), null);
    assert.deepEqual(authorizations, [null, null]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('Tabby model client propagates operation-specific authorization failures', async () => {
  const server = http.createServer((request, response) => {
    if (request.url === '/v1/models') {
      response.statusCode = 401;
      response.end('readiness denied');
      return;
    }
    if (request.url === '/v1/model') {
      response.statusCode = 403;
      response.end('probe denied');
      return;
    }
    if (request.url === '/v1/model/load') {
      response.statusCode = 401;
      response.end('load denied');
      return;
    }
    response.statusCode = 403;
    response.end('unload denied');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${getAddressInfo(server).port}`;
  const client = new TabbyModelClient('admin-secret');
  try {
    await assert.rejects(
      client.isProcessReady(baseUrl, 1_000),
      /Tabby process readiness probe failed with HTTP 401: readiness denied/u,
    );
    await assert.rejects(
      client.getResidentModel(baseUrl, 1_000),
      /Tabby current-model probe failed with HTTP 403: probe denied/u,
    );
    await assert.rejects(
      client.load(baseUrl, {
        model_name: 'model-a',
        max_seq_len: 8192,
        cache_size: 8192,
        cache_mode: 'FP16',
        chunk_size: 512,
      }, 1_000),
      /Tabby model load failed with HTTP 401: load denied/u,
    );
    await assert.rejects(
      client.unload(baseUrl, 1_000),
      /Tabby model unload failed with HTTP 403: unload denied/u,
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('Tabby process readiness returns false for connection failures', async () => {
  assert.equal(await new TabbyModelClient('admin-secret').isProcessReady('http://127.0.0.1:1', 50), false);
});

test('Tabby model client rejects successful load when the model is not resident', async () => {
  const server = http.createServer((request, response) => {
    if (request.url === '/v1/model/load') {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end('data: {"model_type":"model","module":1,"modules":1,"status":"finished"}\n\n');
      return;
    }
    response.statusCode = 503;
    response.end('No models are currently loaded');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${getAddressInfo(server).port}`;
  try {
    await assert.rejects(new TabbyModelClient('').load(baseUrl, {
      model_name: 'model-a',
      max_seq_len: 8192,
      cache_size: 8192,
      cache_mode: 'FP16',
      chunk_size: 512,
    }, 1_000), /model 'model-a' is not resident \(resident=none\)/u);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('Tabby model client rejects a resident model whose applied parameters diverge from the request', async () => {
  const model = new FakeTabbyModelState();
  model.applyResidentModel('model-a', 84_992, 84_992, 512);
  const server = http.createServer((request, response) => {
    if (request.url === '/v1/model/load') {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end('data: {"model_type":"model","module":1,"modules":1,"status":"finished"}\n\n');
      return;
    }
    model.respondCurrentModel(response);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${getAddressInfo(server).port}`;
  const request = {
    model_name: 'model-a',
    max_seq_len: 150_000,
    cache_size: 150_016,
    cache_mode: 'FP16',
    chunk_size: 512,
  };
  try {
    await assert.rejects(
      new TabbyModelClient('').load(baseUrl, request, 1_000),
      /max_seq_len expected 150000 but Tabby applied 84992.*cache_size expected 150016 but Tabby applied 84992/su,
    );
    await assert.rejects(
      new TabbyModelClient('').verifyResident(baseUrl, request, 1_000),
      /max_seq_len expected 150000 but Tabby applied 84992/u,
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('Tabby model client rejects a resident model that reports no applied parameters', async () => {
  const server = http.createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end('{"id":"model-a","parameters":null}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${getAddressInfo(server).port}`;
  try {
    await assert.rejects(
      new TabbyModelClient('').verifyResident(baseUrl, {
        model_name: 'model-a',
        max_seq_len: 8192,
        cache_size: 8192,
        cache_mode: 'FP16',
        chunk_size: 512,
      }, 1_000),
      /reports no applied parameters/u,
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('Tabby model client rejects successful unload when a model remains resident', async () => {
  const server = http.createServer((request, response) => {
    if (request.url === '/v1/model/unload') {
      response.statusCode = 200;
      response.end();
      return;
    }
    response.setHeader('content-type', 'application/json');
    response.end('{"id":"model-a","parameters":{"max_seq_len":8192,"cache_size":8192,"chunk_size":512}}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${getAddressInfo(server).port}`;
  try {
    await assert.rejects(
      new TabbyModelClient('').unload(baseUrl, 1_000),
      /unload completed but 'model-a' is still resident/u,
    );
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
    await assert.rejects(new TabbyModelClient('').load(baseUrl, {
      model_name: 'model-a',
      max_seq_len: 8192,
      cache_size: 8192,
      cache_mode: 'FP16',
      chunk_size: 512,
    }, 1_000), /without a terminal finished event/u);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
