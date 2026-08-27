import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LiveContentClassifier,
} from '../src/llm-protocol/live-content-classifier.js';

test('streams ordinary prose while buffering a possible tool-control prefix', () => {
  const classifier = new LiveContentClassifier();

  assert.deepEqual(classifier.observeContent('Reading the request <'), {
    classification: 'undecided',
    rawText: 'Reading the request <',
    narrationText: 'Reading the request ',
  });
  assert.deepEqual(classifier.observeContent('Reading the request <tool_'), {
    classification: 'undecided',
    rawText: 'Reading the request <tool_',
    narrationText: 'Reading the request ',
  });
});

test('classifies a bare textual tool call and freezes prose before its opener', () => {
  const classifier = new LiveContentClassifier();

  assert.equal(classifier.observeContent('Checking first. ').classification, 'narration');
  assert.deepEqual(classifier.observeContent('Checking first. <tool_call><function=read>'), {
    classification: 'tool_control',
    rawText: 'Checking first. <tool_call><function=read>',
    narrationText: 'Checking first. ',
  });
  assert.deepEqual(classifier.observeContent('Checking first. <tool_call><function=read>ignored'), {
    classification: 'tool_control',
    rawText: 'Checking first. <tool_call><function=read>ignored',
    narrationText: 'Checking first. ',
  });
});

test('native tool-call deltas permanently stop narration growth', () => {
  const classifier = new LiveContentClassifier();
  classifier.observeContent('I will inspect the file.');

  assert.deepEqual(classifier.observeNativeToolCall(), {
    classification: 'tool_control',
    rawText: 'I will inspect the file.',
    narrationText: 'I will inspect the file.',
  });
  assert.equal(
    classifier.observeContent('I will inspect the file. Hidden continuation').narrationText,
    'I will inspect the file.',
  );
});

test('keeps literal tool syntax visible inside completed markdown code', () => {
  const examples = [
    '`<tool_call>` is literal.',
    '```xml\n<tool_call>\n</tool_call>\n```',
  ];

  for (const example of examples) {
    assert.deepEqual(new LiveContentClassifier().observeContent(example), {
      classification: 'narration',
      rawText: example,
      narrationText: example,
    });
  }
});

test('does not promote an incomplete control prefix when the response finishes', () => {
  const classifier = new LiveContentClassifier();
  classifier.observeContent('Visible draft <tool_call');

  assert.deepEqual(classifier.finish(), {
    classification: 'undecided',
    rawText: 'Visible draft <tool_call',
    narrationText: '',
  });
});
