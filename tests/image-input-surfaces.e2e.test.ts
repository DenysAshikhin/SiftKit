import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSummaryRequest } from '../src/status-server/route-request-normalizers.js';
import { buildUserContent } from '../src/llm-protocol/image-attachments.js';

test('parseSummaryRequest accepts images and allows an images-only request', () => {
  const parsed = parseSummaryRequest({
    question: 'what is on screen?',
    inputText: '',
    repoRoot: 'C:\\repo',
    images: ['data:image/png;base64,AAAA'],
  });
  assert.notEqual(parsed, null);
  assert.deepEqual(parsed?.images, ['data:image/png;base64,AAAA']);
});

test('parseSummaryRequest still rejects an empty request with no images', () => {
  assert.equal(parseSummaryRequest({ question: 'q', inputText: '', repoRoot: 'C:\\repo' }), null);
});

test('parseSummaryRequest rejects a malformed image entry', () => {
  assert.throws(
    () => parseSummaryRequest({
      question: 'q',
      inputText: 'x',
      repoRoot: 'C:\\repo',
      images: ['https://example.com/a.png'],
    }),
    /supported-image/u,
  );
});

test('the summary planner puts an image part on the initial user turn', () => {
  const content = buildUserContent('question and input', ['data:image/png;base64,AAAA']);
  assert.deepEqual(content, [
    { type: 'text', text: 'question and input' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
  ]);
});

import { validateRepoSearchTokens } from '../src/cli/args.js';

test('repo-search accepts a repeatable --image flag', () => {
  validateRepoSearchTokens(['--prompt', 'find it', '--image', 'a.png', '--image', 'b.png']);
  assert.throws(
    () => validateRepoSearchTokens(['--prompt', 'find it', '--image']),
    /Missing value for repo-search option: --image/u,
  );
});

import http from 'node:http';
import os from 'node:os';
import { runTaskLoop } from '../src/repo-search/engine.js';
import { createEmptyPresetSystemContext } from './helpers/empty-preset-system-context.js';
import { parseJsonValueText } from '../src/lib/json.js';
import { asObject } from './helpers/dashboard-http.js';

test('repo-search puts the image part on the first user message it sends', async () => {
  const capturedBodies: string[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      capturedBodies.push(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: '{"action":"finish","output":"done"}' } }],
        usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = Number(address && typeof address === 'object' ? address.port : 0);
  try {
    await runTaskLoop(
      { id: 'img', question: 'what is this?', signals: [] },
      {
        repoRoot: os.tmpdir(),
        systemContext: createEmptyPresetSystemContext(),
        model: 'mock',
        baseUrl: `http://127.0.0.1:${port}`,
        maxTurns: 1,
        maxInvalidResponses: 1,
        minToolCallsBeforeFinish: 0,
        loopKind: 'chat',
        plannerToolDefinitions: [],
        initialUserImages: ['data:image/png;base64,AAAA'],
        mockCommandResults: {},
      },
    );
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
  const first = asObject(parseJsonValueText(capturedBodies[0] ?? '{}'));
  assert.equal(JSON.stringify(first).includes('"image_url"'), true);
  assert.equal(JSON.stringify(first).includes('data:image/png;base64,AAAA'), true);
});