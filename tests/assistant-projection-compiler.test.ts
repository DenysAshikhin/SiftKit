import test from 'node:test';
import assert from 'node:assert/strict';

import { EstimateTokenCounter } from '../src/assistant/domain/tokens.js';
import { DossierCompiler } from '../src/assistant/projections/dossier-compiler.js';
import { ProfileCompiler } from '../src/assistant/projections/profile-compiler.js';
import { TokenLimitEnforcer } from '../src/assistant/projections/token-limit-enforcer.js';
import type { AssertionView } from '../src/assistant/projections/assertion-view.js';
import { renderFrontmatter, parseFrontmatter } from '../src/assistant/projections/frontmatter.js';
import { renderAssertionSentence } from '../src/assistant/projections/assertion-sentence.js';
import { RELATION_TYPES } from '../src/assistant/domain/relation-types.js';
import { ProjectionCompiler } from '../src/assistant/projections/projection-compiler.js';
import { withAssistantContextAsync } from './helpers/assistant-fixture.js';

test('frontmatter round-trips every stable field', () => {
  const rendered = renderFrontmatter({
    projectionId: 'memproj_1',
    tier: 2,
    topicKey: 'local-llm-environment',
    generatedAtUtc: '2026-08-05T15:00:00.000Z',
    graphVersion: 184,
    tokenizerId: 'estimate',
    tokenCount: 8421,
    sensitivity: 'personal',
    includedAssertionIds: ['ast_1', 'ast_2'],
  });
  assert.ok(rendered.startsWith('---\n'));
  assert.ok(rendered.includes('generated: true'));
  assert.ok(rendered.includes('do_not_edit: true'));
  const parsed = parseFrontmatter(rendered);
  assert.equal(parsed.projectionId, 'memproj_1');
  assert.equal(parsed.tier, 2);
  assert.equal(parsed.graphVersion, 184);
  assert.deepEqual(parsed.includedAssertionIds, ['ast_1', 'ast_2']);
});

test('an explicit active assertion renders as a plain cited sentence', () => {
  assert.equal(
    renderAssertionSentence({
      assertionId: 'ast_01',
      subjectText: 'the user',
      subjectIsOwner: true,
      predicate: 'USES',
      objectText: 'PowerShell',
      scopeText: '',
      status: 'active',
      basis: 'explicit_user_statement',
      confidence: 0.95,
    }),
    '- Uses PowerShell. [M:ast_01]',
  );
});

test('a scope becomes a qualifier rather than a separate line', () => {
  assert.equal(
    renderAssertionSentence({
      assertionId: 'ast_02',
      subjectText: 'the user',
      subjectIsOwner: true,
      predicate: 'PREFERS',
      objectText: 'PowerShell',
      scopeText: 'Windows command examples',
      status: 'active',
      basis: 'explicit_user_statement',
      confidence: 0.95,
    }),
    '- Prefers PowerShell, for Windows command examples. [M:ast_02]',
  );
});

test('an inferred assertion is labelled and carries its confidence', () => {
  assert.equal(
    renderAssertionSentence({
      assertionId: 'ast_04',
      subjectText: 'the user',
      subjectIsOwner: true,
      predicate: 'USES',
      objectText: 'Visual Studio Code',
      scopeText: '',
      status: 'active',
      basis: 'assistant_inference',
      confidence: 0.72,
    }),
    '- Inferred, not confirmed: uses Visual Studio Code. Confidence 0.72. [M:ast_04]',
  );
});

test('a disputed assertion is always labelled uncertain', () => {
  assert.ok(
    renderAssertionSentence({
      assertionId: 'ast_05',
      subjectText: 'the user',
      subjectIsOwner: true,
      predicate: 'DRIVES',
      objectText: 'a Golf',
      scopeText: '',
      status: 'disputed',
      basis: 'explicit_user_statement',
      confidence: 0.6,
    }).startsWith('- Disputed:'),
  );
});

test('a non-owner subject is named in the line', () => {
  assert.equal(
    renderAssertionSentence({
      assertionId: 'ast_06',
      subjectText: 'SiftKit',
      subjectIsOwner: false,
      predicate: 'DEPENDS_ON',
      objectText: 'better-sqlite3',
      scopeText: '',
      status: 'active',
      basis: 'explicit_user_statement',
      confidence: 0.9,
    }),
    '- SiftKit depends on better-sqlite3. [M:ast_06]',
  );
});

test('every registered predicate has a phrase', () => {
  for (const predicate of RELATION_TYPES) {
    const line = renderAssertionSentence({
      assertionId: 'ast_x', subjectText: 'the user', subjectIsOwner: true, predicate,
      objectText: 'something', scopeText: '', status: 'active',
      basis: 'explicit_user_statement', confidence: 0.9,
    });
    assert.ok(line.includes('[M:ast_x]'));
    assert.ok(!line.includes('undefined'), `${predicate} has no phrase`);
  }
});

function view(overrides: Partial<AssertionView> & { assertionId: string }): AssertionView {
  return {
    subjectText: 'the user',
    subjectIsOwner: true,
    predicate: 'USES',
    objectText: 'PowerShell',
    scopeText: '',
    status: 'active',
    basis: 'explicit_user_statement',
    confidence: 0.9,
    sensitivity: 'personal',
    pinned: false,
    lastObservedAtUtc: '2026-08-05T09:00:00.000Z',
    validFromUtc: null,
    validToUtc: null,
    topicKey: 'general',
    ...overrides,
  };
}

test('the profile renders the documented sections and cites every line', async () => {
  const tokens = new EstimateTokenCounter(4);
  const compiler = new ProfileCompiler(tokens, new TokenLimitEnforcer(tokens));
  const document = await compiler.compile({
    views: [
      view({ assertionId: 'ast_1', predicate: 'PREFERS', objectText: 'PowerShell' }),
      view({ assertionId: 'ast_2', predicate: 'HAS_GOAL', objectText: 'ship the assistant' }),
      view({ assertionId: 'ast_3', predicate: 'HAS_CONSTRAINT', objectText: 'no cloud inference' }),
    ],
    tier2TopicKeys: ['siftkit', 'local-llm-environment'],
  });
  assert.equal(document.tier, 1);
  assert.equal(document.topicKey, 'profile');
  assert.ok(document.body.includes('## Preferences and constraints'));
  assert.ok(document.body.includes('## Active goals'));
  assert.ok(document.body.includes('## Memory topics'));
  assert.ok(document.body.includes('- siftkit'));
  assert.deepEqual([...document.includedAssertionIds].sort(), ['ast_1', 'ast_2', 'ast_3']);
  for (const line of document.body.split('\n').filter((row) => row.startsWith('- Uses'))) {
    assert.ok(line.includes('[M:'), `uncited line: ${line}`);
  }
});

test('the profile never contains a sensitive assertion', async () => {
  const tokens = new EstimateTokenCounter(4);
  const compiler = new ProfileCompiler(tokens, new TokenLimitEnforcer(tokens));
  const document = await compiler.compile({
    views: [
      view({ assertionId: 'ast_1' }),
      view({ assertionId: 'ast_secret', sensitivity: 'sensitive', objectText: 'a health topic' }),
    ],
    tier2TopicKeys: [],
  });
  assert.ok(!document.body.includes('ast_secret'));
  assert.ok(!document.body.includes('a health topic'));
  assert.deepEqual(document.includedAssertionIds, ['ast_1']);
  assert.equal(document.sensitivity, 'personal');
});

test('a dossier renders every documented section heading', async () => {
  const tokens = new EstimateTokenCounter(4);
  const compiler = new DossierCompiler(tokens, new TokenLimitEnforcer(tokens));
  const document = await compiler.compile({
    tier: 2,
    topicKey: 'siftkit',
    title: 'SiftKit',
    views: [
      view({ assertionId: 'ast_1', predicate: 'WORKS_ON', objectText: 'SiftKit' }),
      view({ assertionId: 'ast_2', predicate: 'HAS_SETTING', objectText: '32k context' }),
      view({
        assertionId: 'ast_3', status: 'disputed', predicate: 'DRIVES', objectText: 'a Golf',
      }),
      view({
        assertionId: 'ast_4', basis: 'assistant_inference', confidence: 0.72,
        objectText: 'Visual Studio Code',
      }),
    ],
    relatedTopicKeys: ['local-llm-environment'],
  });
  for (const heading of [
    '# SiftKit', '## Compact summary', '## Stable facts', '## Current state',
    '## Preferences and constraints', '## Active goals and open threads',
    '## Relevant chronology', '## Uncertain or disputed items', '## Related memory topics',
  ]) {
    assert.ok(document.body.includes(heading), `missing ${heading}`);
  }
  assert.ok(document.body.includes('Disputed:'));
  assert.ok(document.body.includes('Inferred, not confirmed:'));
  assert.equal(document.includedAssertionIds.length, 4);
});

test('compiling the same input twice is byte-identical', async () => {
  const tokens = new EstimateTokenCounter(4);
  const compiler = new DossierCompiler(tokens, new TokenLimitEnforcer(tokens));
  const input = {
    tier: 3 as const,
    topicKey: 'kayaking',
    title: 'Kayaking',
    views: [view({ assertionId: 'ast_1', predicate: 'INTERESTED_IN', objectText: 'kayaking' })],
    relatedTopicKeys: [],
  };
  const first = await compiler.compile(input);
  const second = await compiler.compile(input);
  assert.equal(first.body, second.body);
  assert.equal(first.tokenCount, second.tokenCount);
});

test('a document over its tier token limit drops the lowest-value lines and says so', async () => {
  const tokens = new EstimateTokenCounter(4);
  const compiler = new DossierCompiler(tokens, new TokenLimitEnforcer(tokens));
  const views = Array.from({ length: 4_000 }, (_unused, index) =>
    view({ assertionId: `ast_${index}`, objectText: `tool number ${index}` }));
  const document = await compiler.compile({
    tier: 3, topicKey: 'huge', title: 'Huge', views, relatedTopicKeys: [],
  });
  assert.ok(document.tokenCount <= 10_000, 'tier 3 limit is 10 000 tokens');
  assert.ok(document.omittedAssertionCount > 0);
  assert.ok(document.includedAssertionIds.length < views.length);
});

test('compiling an empty graph writes no projections', async () => {
  await withAssistantContextAsync(async ({ graph, ownerId }) => {
    const compiler = new ProjectionCompiler(graph, new EstimateTokenCounter(4));
    const summary = await compiler.compileAll(ownerId);
    assert.equal(summary.written, 0);
    assert.equal(graph.projections.listAll(ownerId).length, 0);
  });
});

test('a core-behaviour fact lands in the tier 1 profile and a dossier fact in tier 2', async () => {
  await withAssistantContextAsync(async ({ graph, ownerId }) => {
    const person = graph.nodes.createNode({
      ownerId, type: 'person', canonicalKey: 'person:owner', displayName: 'the user',
      description: null, sensitivity: 'personal', properties: {},
    });
    const shell = graph.nodes.createNode({
      ownerId, type: 'software', canonicalKey: null, displayName: 'PowerShell',
      description: null, sensitivity: 'low', properties: {},
    });
    const project = graph.nodes.createNode({
      ownerId, type: 'software', canonicalKey: null, displayName: 'SiftKit',
      description: null, sensitivity: 'low', properties: {},
    });
    const evidence = graph.evidence.recordTextEvidence({
      ownerId, deviceId: null, sourceType: 'conversation_message', parentEvidenceId: null,
      sourceEventId: 'chat_1:m1', sourceRef: 'chat_1', sourceTimezone: null,
      capturedAtUtc: '2026-08-05T09:00:00.000Z', sensitivity: 'personal',
      retentionUntilUtc: null, metadata: {}, text: 'seed',
    });
    for (const [predicate, objectNodeId] of [
      ['PREFERS', shell.id], ['USES', project.id],
    ] as const) {
      graph.assertionService.assert({
        ownerId, actorType: 'user', actorRef: null, subjectNodeId: person.id, predicate,
        object: { kind: 'node', nodeId: objectNodeId }, scopeNodeId: null,
        basis: 'explicit_user_statement', sensitivity: 'personal',
        validFromUtc: null, validToUtc: null, observedAtUtc: '2026-08-05T09:00:00.000Z',
        topics: [], attributes: {},
        searchText: { subject: 'the user', predicate, object: 'x', scope: '' },
        evidence: [{ evidenceId: evidence.id, stance: 'supports', weight: 0.9 }],
      });
    }

    const compiler = new ProjectionCompiler(graph, new EstimateTokenCounter(4));
    const summary = await compiler.compileAll(ownerId);
    assert.ok(summary.written >= 2);
    const profile = graph.projections.findByTopic(ownerId, 1, 'profile');
    assert.notEqual(profile, null);
    assert.ok(profile?.content.includes('Prefers PowerShell'));
    assert.equal(profile?.graph_version, graph.graphVersion);
    const dossier = graph.projections.findByTopic(ownerId, 2, 'siftkit');
    assert.notEqual(dossier, null);
    assert.ok(dossier?.content.startsWith('---\n'), 'frontmatter must be written');
  });
});

test('recompiling an unchanged graph rewrites nothing', async () => {
  await withAssistantContextAsync(async ({ graph, ownerId }) => {
    const compiler = new ProjectionCompiler(graph, new EstimateTokenCounter(4));
    await compiler.compileAll(ownerId);
    const before = graph.projections.listAll(ownerId).map((row) => row.content_hash);
    const summary = await compiler.compileAll(ownerId);
    const after = graph.projections.listAll(ownerId).map((row) => row.content_hash);
    assert.deepEqual(after, before);
    assert.equal(summary.written, 0);
    assert.equal(summary.unchanged, before.length);
  });
});

test('a sensitive assertion never reaches a plaintext projection', async () => {
  await withAssistantContextAsync(async ({ graph, ownerId }) => {
    const person = graph.nodes.createNode({
      ownerId, type: 'person', canonicalKey: 'person:owner', displayName: 'the user',
      description: null, sensitivity: 'personal', properties: {},
    });
    const topic = graph.nodes.createNode({
      ownerId, type: 'health_topic', canonicalKey: null, displayName: 'a private matter',
      description: null, sensitivity: 'sensitive', properties: {},
    });
    const evidence = graph.evidence.recordTextEvidence({
      ownerId, deviceId: null, sourceType: 'conversation_message', parentEvidenceId: null,
      sourceEventId: 'chat_1:m2', sourceRef: 'chat_1', sourceTimezone: null,
      capturedAtUtc: '2026-08-05T09:00:00.000Z', sensitivity: 'sensitive',
      retentionUntilUtc: null, metadata: {}, text: 'seed',
    });
    graph.assertionService.assert({
      ownerId, actorType: 'user', actorRef: null, subjectNodeId: person.id,
      predicate: 'INTERESTED_IN', object: { kind: 'node', nodeId: topic.id }, scopeNodeId: null,
      basis: 'explicit_user_statement', sensitivity: 'sensitive',
      validFromUtc: null, validToUtc: null, observedAtUtc: '2026-08-05T09:00:00.000Z',
      topics: [], attributes: {},
      searchText: { subject: 'the user', predicate: 'INTERESTED_IN', object: 'x', scope: '' },
      evidence: [{ evidenceId: evidence.id, stance: 'supports', weight: 0.9 }],
    });
    const compiler = new ProjectionCompiler(graph, new EstimateTokenCounter(4));
    await compiler.compileAll(ownerId);
    for (const projection of graph.projections.listAll(ownerId)) {
      assert.ok(!projection.content.includes('a private matter'));
    }
  });
});

test('tier 2 keeps at most 25 dossiers and demotes the overflow to tier 3', async () => {
  await withAssistantContextAsync(async ({ graph, ownerId }) => {
    const person = graph.nodes.createNode({
      ownerId, type: 'person', canonicalKey: 'person:owner', displayName: 'the user',
      description: null, sensitivity: 'personal', properties: {},
    });
    const evidence = graph.evidence.recordTextEvidence({
      ownerId, deviceId: null, sourceType: 'conversation_message', parentEvidenceId: null,
      sourceEventId: 'chat_1:m3', sourceRef: 'chat_1', sourceTimezone: null,
      capturedAtUtc: '2026-08-05T09:00:00.000Z', sensitivity: 'personal',
      retentionUntilUtc: null, metadata: {}, text: 'seed',
    });
    for (let index = 0; index < 30; index += 1) {
      const tool = graph.nodes.createNode({
        ownerId, type: 'software', canonicalKey: null, displayName: `Project ${index}`,
        description: null, sensitivity: 'low', properties: {},
      });
      graph.assertionService.assert({
        ownerId, actorType: 'user', actorRef: null, subjectNodeId: person.id,
        predicate: 'USES', object: { kind: 'node', nodeId: tool.id }, scopeNodeId: null,
        basis: 'explicit_user_statement', sensitivity: 'personal',
        validFromUtc: null, validToUtc: null, observedAtUtc: '2026-08-05T09:00:00.000Z',
        topics: [], attributes: {},
        searchText: { subject: 'the user', predicate: 'USES', object: 'x', scope: '' },
        evidence: [{ evidenceId: evidence.id, stance: 'supports', weight: 0.9 }],
      });
    }
    const compiler = new ProjectionCompiler(graph, new EstimateTokenCounter(4));
    const summary = await compiler.compileAll(ownerId);
    assert.ok(graph.projections.listByTier(ownerId, 2).length <= 25);
    assert.ok(graph.projections.listByTier(ownerId, 3).length >= 5);
    assert.ok(summary.demotedTopicKeys.length >= 5);
    assert.equal(
      graph.assertions.listBySubject(ownerId, person.id, ['active']).length,
      30,
      'no graph fact is lost to a tier limit',
    );
  });
});