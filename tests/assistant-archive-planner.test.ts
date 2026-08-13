import assert from 'node:assert/strict';
import test from 'node:test';

import { firstSegment, planTier3Archives } from '../src/assistant/projections/archive-planner.js';

const bundle = (topicKey: string): { readonly topicKey: string } => ({ topicKey });

test('under the limit nothing is archived', () => {
  const plan = planTier3Archives([bundle('a'), bundle('b')], 5);
  assert.deepEqual(plan.kept.map((item) => item.topicKey), ['a', 'b']);
  assert.equal(plan.archives.size, 0);
});

test('overflow merges lowest-utility topics into per-segment archives', () => {
  const sorted = ['alpha-one', 'alpha-two', 'beta-one', 'beta-two', 'beta-three', 'gamma-one']
    .map(bundle); // already sorted by utility desc
  const plan = planTier3Archives(sorted, 4);

  // Pops from the tail until kept + archives <= 4: gamma-one opens archive/gamma, beta-three
  // opens archive/beta, then beta-two and beta-one join the existing archive/beta bucket.
  assert.deepEqual(plan.kept.map((item) => item.topicKey), ['alpha-one', 'alpha-two']);
  assert.deepEqual([...plan.archives.keys()].sort(), ['archive/beta', 'archive/gamma']);
  assert.deepEqual(
    plan.archives.get('archive/beta')?.map((item) => item.topicKey),
    ['beta-three', 'beta-two', 'beta-one'],
  );
  assert.deepEqual(
    plan.archives.get('archive/gamma')?.map((item) => item.topicKey), ['gamma-one'],
  );
  assert.equal(plan.kept.length + plan.archives.size, 4);
});

test('all-singleton segments collapse into archive/misc', () => {
  const sorted = ['a-x', 'b-x', 'c-x', 'd-x', 'e-x'].map(bundle);
  const plan = planTier3Archives(sorted, 2);

  assert.deepEqual(plan.kept, []);
  assert.deepEqual([...plan.archives.keys()], ['archive/misc']);
  assert.deepEqual(
    plan.archives.get('archive/misc')?.map((item) => item.topicKey),
    ['e-x', 'd-x', 'c-x', 'b-x', 'a-x'],
  );
  assert.ok(plan.kept.length + plan.archives.size <= 2);
});

test('one shared segment collapses the whole overflow into a single archive document', () => {
  const sorted = Array.from({ length: 40 }, (_, index) => bundle(`topic-${String(index).padStart(2, '0')}`));
  const plan = planTier3Archives(sorted, 10);

  assert.equal(plan.kept.length, 9);
  assert.deepEqual([...plan.archives.keys()], ['archive/topic']);
  assert.equal(plan.archives.get('archive/topic')?.length, 31);
  assert.equal(plan.kept.length + plan.archives.size, 10);
});

test('the same input always yields the same plan and never mutates it', () => {
  const sorted = Array.from({ length: 40 }, (_, index) => bundle(`topic-${String(index).padStart(2, '0')}`));
  const first = planTier3Archives(sorted, 10);
  const second = planTier3Archives(sorted, 10);
  assert.deepEqual(second, first);
  assert.equal(sorted.length, 40);
});

test('firstSegment splits on hyphen and slash', () => {
  assert.equal(firstSegment('visual-studio-code'), 'visual');
  assert.equal(firstSegment('archive/beta'), 'archive');
  assert.equal(firstSegment('solo'), 'solo');
  assert.equal(firstSegment(''), 'misc');
  assert.equal(firstSegment('-leading'), 'misc');
});
