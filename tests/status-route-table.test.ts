import assert from 'node:assert/strict';
import test from 'node:test';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { z } from '../src/lib/zod.js';
import { RouteTable, type RouteEndpoint, type RouteMatch } from '../src/status-server/route-table.js';
import type { ServerContext } from '../src/status-server/server-types.js';

class RecordingEndpoint implements RouteEndpoint {
  matches: RouteMatch[] = [];

  handle(_ctx: never, _req: never, _res: never, match: RouteMatch): void {
    this.matches.push(match);
  }
}

// RouteTable.handle only reads req.method and forwards ctx/res untouched to the
// endpoint (RecordingEndpoint ignores them), so minimal runtime stubs are branded
// to the wire types at this single test boundary.
const StubContextSchema = z.custom<ServerContext>(() => true);
const StubResponseSchema = z.custom<ServerResponse>(() => true);
const StubRequestSchema = z.custom<IncomingMessage>(() => true);
const stubContext = (): ServerContext => StubContextSchema.parse({});
const stubResponse = (): ServerResponse => StubResponseSchema.parse({});
function request(method: string): IncomingMessage {
  return StubRequestSchema.parse({ method });
}

test('RouteTable dispatches exact method and string path matches', async () => {
  const endpoint = new RecordingEndpoint();
  const table = new RouteTable([{ method: 'GET', path: '/health', endpoint }]);

  const handled = await table.handle(stubContext(), request('GET'), stubResponse(), '/health');

  assert.equal(handled, true);
  assert.deepEqual(endpoint.matches, [{ pathname: '/health', captures: [] }]);
});

test('RouteTable returns false for path matches with the wrong method', async () => {
  const endpoint = new RecordingEndpoint();
  const table = new RouteTable([{ method: 'POST', path: '/summary', endpoint }]);

  const handled = await table.handle(stubContext(), request('GET'), stubResponse(), '/summary');

  assert.equal(handled, false);
  assert.equal(table.hasPath('/summary'), true);
  assert.equal(endpoint.matches.length, 0);
});

test('RouteTable exposes regex captures to endpoint objects', async () => {
  const endpoint = new RecordingEndpoint();
  const table = new RouteTable([
    { method: 'DELETE', path: /^\/dashboard\/runs\/([^/]+)$/u, endpoint },
  ]);

  const handled = await table.handle(stubContext(), request('DELETE'), stubResponse(), '/dashboard/runs/run-1');

  assert.equal(handled, true);
  assert.deepEqual(endpoint.matches, [{ pathname: '/dashboard/runs/run-1', captures: ['run-1'] }]);
});
