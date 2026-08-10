import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AssistantTab } from '../src/tabs/AssistantTab.js';
import type { AssistantTabProps } from '../src/tabs/AssistantTab.js';

const PROPS = {
  available: true,
  enabled: true,
  loading: false,
  error: null,
  query: 'concise',
  results: {
    nodes: [{ id: 'node-1', type: 'person', displayName: 'Denys', sensitivity: 'personal' }],
    assertions: [{
      id: 'assertion-1', subjectNodeId: 'node-1', predicate: 'prefers',
      objectText: 'concise answers', scopeText: '', status: 'active', basis: 'explicit_user_statement',
      confidence: 0.95, sensitivity: 'personal', pinned: false, userDemoted: false,
      validFromUtc: null, validToUtc: null, lastObservedAtUtc: '2026-08-10T10:00:00.000Z',
    }],
    projections: [{
      id: 'projection-1', tier: 1, topicKey: 'writing', title: 'Writing preferences',
      tokenCount: 12, sensitivity: 'personal', graphVersion: 4, content: 'Prefers concise answers.',
    }],
  },
  selected: null,
  question: {
    id: 'question-1', topicKey: 'writing', questionText: 'Should this apply to all writing?',
    questionType: 'clarify_scope', status: 'eligible', eligibleAfterUtc: null,
    expiresAtUtc: null, createdAtUtc: '2026-08-10T10:00:00.000Z',
  },
  policies: [{ id: 'policy-1', policyType: 'block_topic', topicKey: 'private', active: true }],
  deletionPreview: null,
  onQueryChange() {},
  async onSearch() {},
  async onSelectNode() {},
  async onSelectAssertion() {},
  onSelectProjection() {},
  async onConfirm() {},
  async onCorrect() {},
  async onPin() {},
  async onDemote() {},
  async onPreviewForget() {},
  async onConfirmForget() {},
  async onAnswerQuestion() {},
  async onSkipQuestion() {},
  async onSnoozeQuestion() {},
  async onBlockQuestionTopic() {},
  async onSetPolicyEnabled() {},
  async onDeletePolicy() {},
} satisfies AssistantTabProps;

test('assistant inspector renders three regions, memory results, question, and policies', () => {
  const markup = renderToStaticMarkup(<AssistantTab {...PROPS} />);
  assert.match(markup, /assistant-inspector/);
  assert.match(markup, /Search memory/);
  assert.match(markup, /concise answers/);
  assert.match(markup, /Writing preferences/);
  assert.match(markup, /Should this apply to all writing\?/);
  assert.match(markup, /Question policies/);
});

test('assistant inspector renders disabled and error states without exposing a token', () => {
  const markup = renderToStaticMarkup(
    <AssistantTab {...PROPS} enabled={false} error="Assistant is disabled." results={null} question={null} />,
  );
  assert.match(markup, /Assistant is disabled/);
  assert.doesNotMatch(markup, /Bearer|session-secret/);
});
