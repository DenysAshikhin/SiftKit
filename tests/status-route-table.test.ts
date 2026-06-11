import * as assert from 'node:assert/strict';
import test from 'node:test';

import { RouteTable, type RouteEndpoint, type RouteMatch } from '../src/status-server/route-table.js';

class RecordingEndpoint implements RouteEndpoint {
  matches: RouteMatch[] = [];

  handle(_ctx: never, _req: never, _res: never, match: RouteMatch): void {
    this.matches.push(match);
  }
}

function request(method: string): { method: string } {
  return { method };
}

test('RouteTable dispatches exact method and string path matches', async () => {
  const endpoint = new RecordingEndpoint();
  const table = new RouteTable([{ method: 'GET', path: '/health', endpoint }]);

  const handled = await table.handle({} as never, request('GET') as never, {} as never, '/health');

  assert.equal(handled, true);
  assert.deepEqual(endpoint.matches, [{ pathname: '/health', captures: [] }]);
});

test('RouteTable returns false for path matches with the wrong method', async () => {
  const endpoint = new RecordingEndpoint();
  const table = new RouteTable([{ method: 'POST', path: '/summary', endpoint }]);

  const handled = await table.handle({} as never, request('GET') as never, {} as never, '/summary');

  assert.equal(handled, false);
  assert.equal(table.hasPath('/summary'), true);
  assert.equal(endpoint.matches.length, 0);
});

test('RouteTable exposes regex captures to endpoint objects', async () => {
  const endpoint = new RecordingEndpoint();
  const table = new RouteTable([
    { method: 'DELETE', path: /^\/dashboard\/runs\/([^/]+)$/u, endpoint },
  ]);

  const handled = await table.handle({} as never, request('DELETE') as never, {} as never, '/dashboard/runs/run-1');

  assert.equal(handled, true);
  assert.deepEqual(endpoint.matches, [{ pathname: '/dashboard/runs/run-1', captures: ['run-1'] }]);
});
