import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { recordServerError } from '../src/status-server/error-response.js';
import { JsonRecordReader } from '../src/lib/json-record-reader.js';
import { getAddressInfo } from './helpers/dashboard-http.js';
import { withTempEnv } from './_runtime-helpers.js';

test('recordServerError returns the persisted diagnostic payload without sending a response', async () => {
  await withTempEnv(async () => {
    const server = http.createServer((req, res) => {
      const payload = recordServerError(req, 500, new TypeError('stream failed'), {
        taskKind: 'summary',
        requestId: 'req-1',
      });
      assert.equal(res.headersSent, false);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const body = await new Promise<string>((resolve, reject) => {
        const request = http.request(`http://127.0.0.1:${getAddressInfo(server).port}/summary`, (response) => {
          let text = '';
          response.setEncoding('utf8');
          response.on('data', (chunk: string) => { text += chunk; });
          response.on('end', () => resolve(text));
        });
        request.on('error', reject);
        request.end();
      });
      const parsed = JsonRecordReader.parseObjectText(body);
      assert.ok(parsed);
      const payload = new JsonRecordReader(parsed);
      assert.equal(payload.string('error'), 'stream failed');
      assert.equal(payload.string('errorName'), 'TypeError');
      assert.ok(payload.string('diagnosticId'));
      const diagnostic = payload.object('diagnostic');
      assert.ok(diagnostic);
      assert.equal(new JsonRecordReader(diagnostic).string('message'), 'stream failed');
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
