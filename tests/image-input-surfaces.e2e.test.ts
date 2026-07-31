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