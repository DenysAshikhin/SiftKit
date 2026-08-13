import { EstimateTokenCounter } from '../../src/assistant/domain/tokens.js';
import { ProjectionCompiler } from '../../src/assistant/projections/projection-compiler.js';
import type {
  ProjectionSummaryService, SummarizeProjectionResult,
} from '../../src/assistant/projections/projection-summarizer.js';
import { OWNER_PERSON_CANONICAL_KEY } from '../../src/assistant/storage/schema.js';
import { DEFAULT_ASSISTANT_CONFIG } from '../../src/config/defaults.js';
import { closeRuntimeDatabase } from '../../src/state/runtime-db.js';
import {
  DEFAULT_BENCH_ROOT, OWNER_ID, activityEvent, formatSeconds, openBench,
  readNumberArg, readStringArg, type BenchContext,
} from './shared.js';

const OBJECT_NODE_COUNT = 2_000;
const ACTIVITY_EVENT_COUNT = 10_000;
const CHUNK_ROWS = 1_000;
/** One shared evidence text per 50 assertions, so the content-addressed blobs dedupe. */
const ASSERTIONS_PER_EVIDENCE = 50;

class PassthroughSummarizer implements ProjectionSummaryService {
  async summarize(): Promise<SummarizeProjectionResult> {
    return { kind: 'unchanged', reason: 'benchmark' };
  }
}

/** Runs `work` in explicit transactions of `CHUNK_ROWS` rows, so one BEGIN never spans the seed. */
function inChunks(context: BenchContext, total: number, work: (index: number) => void): void {
  for (let start = 0; start < total; start += CHUNK_ROWS) {
    const transaction = context.graph.transactions.begin();
    try {
      for (let index = start; index < Math.min(start + CHUNK_ROWS, total); index += 1) {
        work(index);
      }
      transaction.commit();
    } catch (error) {
      transaction.rollbackAfter(error);
    }
  }
}

function seedOwnerNode(context: BenchContext): string {
  const existing = context.graph.nodes.findByCanonicalKey(
    OWNER_ID, 'person', OWNER_PERSON_CANONICAL_KEY,
  );
  if (existing !== null) return existing.id;
  return context.graph.nodes.createNode({
    ownerId: OWNER_ID, type: 'person', canonicalKey: OWNER_PERSON_CANONICAL_KEY,
    displayName: 'the user', description: null, sensitivity: 'personal', properties: {},
  }).id;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const root = readStringArg(argv, '--root', DEFAULT_BENCH_ROOT);
  const assertionCount = readNumberArg(argv, '--assertions', 100_000);
  const context = openBench(root);
  const startedAtMs = Date.now();
  try {
    const ownerNodeId = seedOwnerNode(context);

    const objectNodeIds: string[] = [];
    inChunks(context, OBJECT_NODE_COUNT, (index) => {
      objectNodeIds.push(context.graph.nodes.createNode({
        ownerId: OWNER_ID, type: 'software', canonicalKey: `software:bench-${index}`,
        displayName: `Bench Tool ${index}`, description: null,
        sensitivity: 'personal', properties: {},
      }).id);
    });
    process.stdout.write(`nodes: ${objectNodeIds.length} (${formatSeconds(startedAtMs)})\n`);

    const evidenceIds: string[] = [];
    inChunks(
      context,
      Math.ceil(assertionCount / ASSERTIONS_PER_EVIDENCE),
      (index) => {
        evidenceIds.push(context.graph.evidence.recordTextEvidence({
          ownerId: OWNER_ID, deviceId: null, parentEvidenceId: null,
          sourceType: 'conversation_message', sourceEventId: `bench-evidence:${index}`,
          sourceRef: null, capturedAtUtc: context.graph.nowUtc(), sourceTimezone: null,
          sensitivity: 'personal', retentionUntilUtc: null, metadata: {},
          text: `bench evidence batch ${index}`,
        }).id);
      },
    );
    process.stdout.write(`evidence: ${evidenceIds.length} (${formatSeconds(startedAtMs)})\n`);

    let rejected = 0;
    inChunks(context, assertionCount, (index) => {
      const objectNodeId = objectNodeIds[index % objectNodeIds.length] ?? '';
      const evidenceId = evidenceIds[Math.floor(index / ASSERTIONS_PER_EVIDENCE)] ?? '';
      const outcome = context.graph.assertionService.assert({
        ownerId: OWNER_ID, actorType: 'user', actorRef: OWNER_ID, subjectNodeId: ownerNodeId,
        predicate: 'USES', object: { kind: 'node', nodeId: objectNodeId }, scopeNodeId: null,
        basis: 'explicit_user_statement', sensitivity: 'personal',
        validFromUtc: null, validToUtc: null, observedAtUtc: context.graph.nowUtc(),
        topics: [], attributes: { benchIndex: index },
        searchText: {
          subject: 'the user', predicate: 'USES',
          object: `Bench Tool ${index % objectNodeIds.length}`, scope: '',
        },
        evidence: [{ evidenceId, stance: 'supports', weight: 1 }],
      });
      if (outcome.kind === 'rejected') rejected += 1;
    });
    process.stdout.write(
      `assertions: ${assertionCount - rejected} written, ${rejected} rejected `
      + `(${formatSeconds(startedAtMs)})\n`,
    );

    await new ProjectionCompiler(
      context.graph, new EstimateTokenCounter(4), new PassthroughSummarizer(),
      { 1: 10_000, 2: 50_000, 3: 10_000 },
    ).compileAll(OWNER_ID, new AbortController().signal);
    process.stdout.write(
      `projections: ${context.graph.projections.listAllRows(OWNER_ID).length} `
      + `(${formatSeconds(startedAtMs)})\n`,
    );

    const activityConfig = {
      ...DEFAULT_ASSISTANT_CONFIG,
      Enabled: true,
      Observation: { ...DEFAULT_ASSISTANT_CONFIG.Observation, ActivityMetadataEnabled: true },
    };
    const activityStartMs = Date.parse(context.graph.nowUtc()) - ACTIVITY_EVENT_COUNT * 1_000;
    inChunks(context, ACTIVITY_EVENT_COUNT, (index) => {
      context.activity.ingest(
        OWNER_ID,
        activityEvent(index, new Date(activityStartMs + index * 1_000).toISOString()),
        activityConfig,
      );
    });
    process.stdout.write(
      `activity events: ${ACTIVITY_EVENT_COUNT} (${formatSeconds(startedAtMs)})\n`,
    );
    process.stdout.write(`seeded ${context.root} in ${formatSeconds(startedAtMs)}\n`);
  } finally {
    closeRuntimeDatabase();
  }
}

await main();
