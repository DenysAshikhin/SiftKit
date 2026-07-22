import test from 'node:test';
import assert from 'node:assert/strict';

import { summarizeRequest } from '../src/summary.js';
import type { SummaryProgressEvent } from '../src/summary/progress-reporter.js';
import { SilentProgressWriter } from '../src/lib/progress-writer.js';
import { CollectingProgressWriter } from './helpers/collecting-progress-writer.js';
import {
  withStubServer,
  withTempEnv,
} from './_runtime-helpers.js';

test('summary emits preflight tokenization progress', async () => {
  await withTempEnv(async () => {
    await withStubServer(async () => {
      const writer = new CollectingProgressWriter<SummaryProgressEvent>();
      await summarizeRequest({
        question: 'summarize this',
        inputText: 'A'.repeat(5_000),
        format: 'text',
        policyProfile: 'general',
        backend: 'llama.cpp',
        model: 'mock-model',
        progressWriter: writer,
      });

      const kinds = writer.events.map((event) => event.kind);
      assert.deepEqual(kinds.slice(0, 2), ['start', 'config_start']);
      assert.ok(kinds.includes('completed'));
      const tokenizeStart = writer.events.find((event) => event.kind === 'tokenize_start');
      assert.equal(tokenizeStart?.phase, 'leaf');
      assert.ok((tokenizeStart?.promptChars ?? 0) > 0);
      const tokenizeDone = writer.events.find((event) => event.kind === 'tokenize_done');
      assert.equal(tokenizeDone?.promptTokens, 456);
      assert.equal(tokenizeDone?.tokenSource, 'llama.cpp');
    }, {
      tokenizeTokenCount: () => 456,
      metrics: {
        inputCharactersTotal: 3_461_904,
        inputTokensTotal: 1_865_267,
        outputCharactersTotal: 0,
        outputTokensTotal: 0,
        thinkingTokensTotal: 0,
        completedRequestCount: 0,
        requestDurationMsTotal: 0,
      },
    });
  });
});

test('summary rejects before loading configuration when already aborted', async () => {
  const controller = new AbortController();
  controller.abort(new Error('client disconnected'));
  await assert.rejects(
    () => summarizeRequest({
      question: 'summarize this',
      inputText: 'ordinary input',
      format: 'text',
      policyProfile: 'general',
      backend: 'mock',
      progressWriter: new SilentProgressWriter<SummaryProgressEvent>(),
      abortSignal: controller.signal,
    }),
    /client disconnected/u,
  );
});
