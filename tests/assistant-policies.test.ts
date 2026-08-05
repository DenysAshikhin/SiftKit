import test from 'node:test';
import assert from 'node:assert/strict';

import { PolicyStore } from '../src/assistant/storage/policy-store.js';
import { withAssistantContext, type AssistantTestContext } from './helpers/assistant-fixture.js';

function newPolicyStore(context: AssistantTestContext): PolicyStore {
  return new PolicyStore(context.database, context.clock, context.ids);
}

test('a policy is created, read by type and key, and listed', () => {
  withAssistantContext((context) => {
    const policies = newPolicyStore(context);
    const created = policies.upsertPolicy({
      ownerId: context.ownerId, policyType: 'never_infer_topic', key: 'health',
      value: { reason: 'user asked' }, enabled: true, source: 'user',
    });
    assert.equal(created.policy_type, 'never_infer_topic');
    assert.equal(created.enabled, true);

    const found = policies.findPolicy(context.ownerId, 'never_infer_topic', 'health');
    assert.equal(found?.id, created.id);
    assert.deepEqual(
      policies.listPolicies(context.ownerId, 'never_infer_topic').map((row) => row.key),
      ['health'],
    );
  });
});

test('upserting the same type and key updates in place rather than duplicating', () => {
  withAssistantContext((context) => {
    const policies = newPolicyStore(context);
    const first = policies.upsertPolicy({
      ownerId: context.ownerId, policyType: 'never_infer_topic', key: 'finance',
      value: { reason: 'v1' }, enabled: true, source: 'user',
    });
    const second = policies.upsertPolicy({
      ownerId: context.ownerId, policyType: 'never_infer_topic', key: 'finance',
      value: { reason: 'v2' }, enabled: false, source: 'user',
    });
    assert.equal(second.id, first.id);
    assert.equal(second.enabled, false);
    assert.equal(JSON.parse(second.value_json).reason, 'v2');
    assert.equal(policies.listPolicies(context.ownerId, 'never_infer_topic').length, 1);
  });
});

test('a disabled policy is not enforced', () => {
  withAssistantContext((context) => {
    const policies = newPolicyStore(context);
    policies.upsertPolicy({
      ownerId: context.ownerId, policyType: 'never_infer_topic', key: 'health',
      value: {}, enabled: false, source: 'user',
    });
    assert.equal(policies.isTopicBlockedFromInference(context.ownerId, 'health'), false);

    policies.setEnabled(context.ownerId, 'never_infer_topic', 'health', true);
    assert.equal(policies.isTopicBlockedFromInference(context.ownerId, 'health'), true);
  });
});

test('never-infer topic matching is normalized, not raw', () => {
  withAssistantContext((context) => {
    const policies = newPolicyStore(context);
    policies.upsertPolicy({
      ownerId: context.ownerId, policyType: 'never_infer_topic', key: '  Mental   Health ',
      value: {}, enabled: true, source: 'user',
    });
    assert.equal(policies.isTopicBlockedFromInference(context.ownerId, 'mental health'), true);
    assert.equal(policies.isTopicBlockedFromInference(context.ownerId, 'MENTAL HEALTH'), true);
    assert.equal(policies.isTopicBlockedFromInference(context.ownerId, 'health'), false);
  });
});

test('do-not-merge is symmetric across the node pair', () => {
  withAssistantContext((context) => {
    const policies = newPolicyStore(context);
    policies.blockMerge(context.ownerId, 'node_b', 'node_a', 'the user said they differ');
    assert.equal(policies.isMergeBlocked(context.ownerId, 'node_a', 'node_b'), true);
    assert.equal(policies.isMergeBlocked(context.ownerId, 'node_b', 'node_a'), true);
    assert.equal(policies.isMergeBlocked(context.ownerId, 'node_a', 'node_c'), false);
  });
});

test('an assertion lock is set, queried, and cleared', () => {
  withAssistantContext((context) => {
    const policies = newPolicyStore(context);
    assert.equal(policies.isAssertionLocked(context.ownerId, 'ast_1'), false);
    policies.lockAssertion(context.ownerId, 'ast_1', 'user pinned this fact');
    assert.equal(policies.isAssertionLocked(context.ownerId, 'ast_1'), true);
    policies.deletePolicy(context.ownerId, 'assertion_lock', 'ast_1');
    assert.equal(policies.isAssertionLocked(context.ownerId, 'ast_1'), false);
  });
});