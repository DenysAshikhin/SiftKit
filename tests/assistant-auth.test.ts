import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AssistantRouteGuard,
  AssistantTokenStore,
  type AssistantAuthRequest,
} from '../src/status-server/assistant-auth.js';
import { withAssistantContext } from './helpers/assistant-fixture.js';

function request(overrides: Partial<AssistantAuthRequest> = {}): AssistantAuthRequest {
  return {
    remoteAddress: '127.0.0.1',
    host: '127.0.0.1:9475',
    origin: null,
    authorization: null,
    ...overrides,
  };
}

test('AssistantTokenStore creates one stable 32-byte base64url token per database', () => {
  let firstDatabaseToken = '';
  withAssistantContext(({ database, clock }) => {
    const store = new AssistantTokenStore(database, clock);
    firstDatabaseToken = store.getOrCreate();
    assert.equal(Buffer.from(firstDatabaseToken, 'base64url').length, 32);
    assert.equal(store.getOrCreate(), firstDatabaseToken);
  });
  withAssistantContext(({ database, clock }) => {
    assert.notEqual(new AssistantTokenStore(database, clock).getOrCreate(), firstDatabaseToken);
  });
});

test('the route guard accepts loopback forms and hides routes from remote peers', () => {
  withAssistantContext(({ database, clock }) => {
    const store = new AssistantTokenStore(database, clock);
    const guard = new AssistantRouteGuard(store);
    const token = store.getOrCreate();
    for (const remoteAddress of ['127.0.0.1', '127.8.9.10', '::1', '::ffff:127.0.0.1']) {
      assert.equal(guard.authorize(request({
        remoteAddress,
        authorization: `Bearer ${token}`,
      }), 'bearer').kind, 'authorized');
    }
    assert.deepEqual(
      guard.authorize(request({ remoteAddress: '192.168.1.5' }), 'bootstrap'),
      { kind: 'denied', statusCode: 404 },
    );
  });
});

test('bearer authorization rejects missing, malformed, and wrong tokens', () => {
  withAssistantContext(({ database, clock }) => {
    const store = new AssistantTokenStore(database, clock);
    const guard = new AssistantRouteGuard(store);
    const token = store.getOrCreate();
    for (const authorization of [null, token, 'Basic abc', 'Bearer wrong', `Bearer ${token}x`]) {
      assert.deepEqual(
        guard.authorize(request({ authorization }), 'bearer'),
        { kind: 'denied', statusCode: 401 },
      );
    }
    assert.deepEqual(
      guard.authorize(request({ authorization: `Bearer ${token}` }), 'bearer'),
      { kind: 'authorized' },
    );
  });
});

test('bootstrap allows no Origin or exact same origin and rejects cross-origin requests', () => {
  withAssistantContext(({ database, clock }) => {
    const store = new AssistantTokenStore(database, clock);
    const guard = new AssistantRouteGuard(store);
    assert.deepEqual(guard.authorize(request(), 'bootstrap'), {
      kind: 'authorized', token: store.getOrCreate(), cacheControl: 'no-store',
    });
    assert.equal(guard.authorize(request({ origin: 'http://127.0.0.1:9475' }), 'bootstrap').kind, 'authorized');
    for (const origin of ['http://localhost:9475', 'http://127.0.0.1:9000', 'https://127.0.0.1:9475', 'null']) {
      assert.deepEqual(
        guard.authorize(request({ origin }), 'bootstrap'),
        { kind: 'denied', statusCode: 403 },
      );
    }
  });
});
