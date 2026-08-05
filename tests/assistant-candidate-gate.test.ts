import test from 'node:test';
import assert from 'node:assert/strict';

import { CandidateGate } from '../src/assistant/ingestion/candidate-gate.js';
import { SecretScanner } from '../src/assistant/domain/secrets.js';
import { withAssistantContext } from './helpers/assistant-fixture.js';

function baseInput(ownerId: string) {
  return {
    ownerId,
    predicate: 'USES',
    basis: 'explicit_user_statement',
    sourceType: 'conversation_message',
    confidence: 0.9,
    rationale: 'The user said so.',
    validFromUtc: null,
    validToUtc: null,
    subjectText: 'the user',
    objectText: 'PowerShell',
  } as const;
}

test('a well-formed explicit statement is accepted at its stated confidence', () => {
  withAssistantContext(({ graph, ownerId }) => {
    const gate = new CandidateGate(graph.policies, new SecretScanner());
    const outcome = gate.evaluate(baseInput(ownerId));
    assert.equal(outcome.kind, 'accept');
    assert.equal(outcome.kind === 'accept' ? outcome.confidence : 0, 0.9);
  });
});

test('confidence above the basis ceiling is clamped, not rejected', () => {
  withAssistantContext(({ graph, ownerId }) => {
    const gate = new CandidateGate(graph.policies, new SecretScanner());
    const outcome = gate.evaluate({
      ...baseInput(ownerId), basis: 'assistant_inference', confidence: 0.99,
    });
    assert.equal(outcome.kind, 'accept');
    assert.equal(outcome.kind === 'accept' ? outcome.confidence : 0, 0.75);
  });
});

test('an empty rationale is rejected', () => {
  withAssistantContext(({ graph, ownerId }) => {
    const gate = new CandidateGate(graph.policies, new SecretScanner());
    const outcome = gate.evaluate({ ...baseInput(ownerId), rationale: '   ' });
    assert.equal(outcome.kind, 'reject');
    assert.equal(outcome.kind === 'reject' ? outcome.code : '', 'empty_rationale');
  });
});

test('credential material in the object is rejected', () => {
  withAssistantContext(({ graph, ownerId }) => {
    const gate = new CandidateGate(graph.policies, new SecretScanner());
    const outcome = gate.evaluate({
      ...baseInput(ownerId), objectText: 'ghp_0123456789abcdefghijklmnopqrstuvwxyzAB',
    });
    assert.equal(outcome.kind, 'reject');
    assert.equal(outcome.kind === 'reject' ? outcome.code : '', 'secret_prohibited');
  });
});

test('a chat message cannot support a passive-observation basis', () => {
  withAssistantContext(({ graph, ownerId }) => {
    const gate = new CandidateGate(graph.policies, new SecretScanner());
    const outcome = gate.evaluate({ ...baseInput(ownerId), basis: 'passive_observation' });
    assert.equal(outcome.kind, 'reject');
    assert.equal(outcome.kind === 'reject' ? outcome.code : '', 'basis_unsupported');
  });
});

test('inconsistent validity dates are rejected', () => {
  withAssistantContext(({ graph, ownerId }) => {
    const gate = new CandidateGate(graph.policies, new SecretScanner());
    assert.equal(
      gate.evaluate({
        ...baseInput(ownerId),
        validFromUtc: '2026-08-05T00:00:00.000Z', validToUtc: '2026-08-01T00:00:00.000Z',
      }).kind,
      'reject',
    );
    assert.equal(
      gate.evaluate({ ...baseInput(ownerId), validFromUtc: 'yesterday', validToUtc: null }).kind,
      'reject',
    );
  });
});

test('a sensitive topic inferred rather than stated requires confirmation', () => {
  withAssistantContext(({ graph, ownerId }) => {
    const gate = new CandidateGate(graph.policies, new SecretScanner());
    const outcome = gate.evaluate({
      ...baseInput(ownerId), basis: 'assistant_inference', confidence: 0.7,
      objectText: 'a new medication from my doctor',
    });
    assert.equal(outcome.kind, 'needs_confirmation');
  });
});

test('a sensitive topic the user stated explicitly is accepted without confirmation', () => {
  withAssistantContext(({ graph, ownerId }) => {
    const gate = new CandidateGate(graph.policies, new SecretScanner());
    const outcome = gate.evaluate({
      ...baseInput(ownerId), objectText: 'a new medication from my doctor',
    });
    assert.equal(outcome.kind, 'accept');
  });
});

test('a never_infer_topic policy rejects the candidate outright', () => {
  withAssistantContext(({ graph, ownerId }) => {
    graph.policies.upsertPolicy({
      ownerId, policyType: 'never_infer_topic', key: 'finance',
      value: { topic: 'finance' }, enabled: true, source: 'user',
    });
    const gate = new CandidateGate(graph.policies, new SecretScanner());
    const outcome = gate.evaluate({
      ...baseInput(ownerId), objectText: 'my mortgage and bank account',
    });
    assert.equal(outcome.kind, 'reject');
    assert.equal(outcome.kind === 'reject' ? outcome.code : '', 'blocked_topic');
  });
});

test('a confidence outside [0, 1] is rejected', () => {
  withAssistantContext(({ graph, ownerId }) => {
    const gate = new CandidateGate(graph.policies, new SecretScanner());
    assert.equal(gate.evaluate({ ...baseInput(ownerId), confidence: 1.5 }).kind, 'reject');
    assert.equal(gate.evaluate({ ...baseInput(ownerId), confidence: -0.1 }).kind, 'reject');
  });
});