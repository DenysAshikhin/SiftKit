import { hashBytes } from '../../src/assistant/domain/keys.js';
import { EstimateTokenCounter } from '../../src/assistant/domain/tokens.js';
import { CaptureQueueStore } from '../../src/assistant/images/capture-queue-store.js';
import { MemoryRetriever } from '../../src/assistant/retrieval/memory-retriever.js';
import { OWNER_PERSON_CANONICAL_KEY } from '../../src/assistant/storage/schema.js';
import { DEFAULT_ASSISTANT_CONFIG } from '../../src/config/defaults.js';
import { closeRuntimeDatabase } from '../../src/state/runtime-db.js';
import {
  DEFAULT_BENCH_ROOT, OWNER_ID, activityEvent, openBench, readStringArg,
} from './shared.js';

const WARMUP_ITERATIONS = 10;
const DEFAULT_ITERATIONS = 1_000;
const RETRIEVAL_ITERATIONS = 50;
/** 2 MP of RGBA, the shape the capture intake hashes before it can dedupe. */
const CAPTURE_PIXEL_BYTES = 2_000_000 * 4;

interface Measurement {
  readonly name: string;
  readonly budgetMs: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly iterations: number;
}

function percentile(sortedMs: readonly number[], fraction: number): number {
  if (sortedMs.length === 0) return 0;
  const index = Math.min(sortedMs.length - 1, Math.ceil(fraction * sortedMs.length) - 1);
  return sortedMs[Math.max(0, index)] ?? 0;
}

async function measure(
  name: string,
  budgetMs: number,
  iterations: number,
  work: (index: number) => Promise<void> | void,
): Promise<Measurement> {
  for (let index = 0; index < WARMUP_ITERATIONS; index += 1) await work(index);
  const samples: number[] = [];
  for (let index = 0; index < iterations; index += 1) {
    const startedAt = process.hrtime.bigint();
    await work(index);
    samples.push(Number(process.hrtime.bigint() - startedAt) / 1e6);
  }
  samples.sort((left, right) => left - right);
  return {
    name,
    budgetMs,
    p50Ms: percentile(samples, 0.5),
    p95Ms: percentile(samples, 0.95),
    iterations,
  };
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : `${value}${' '.repeat(width - value.length)}`;
}

function padStart(value: string, width: number): string {
  return value.length >= width ? value : `${' '.repeat(width - value.length)}${value}`;
}

function report(measurements: readonly Measurement[]): void {
  const nameWidth = Math.max(11, ...measurements.map((row) => row.name.length));
  process.stdout.write(
    `${pad('Measurement', nameWidth)} | ${padStart('p50 ms', 9)} | ${padStart('p95 ms', 9)}`
    + ` | ${padStart('budget ms', 9)} | n      | verdict\n`,
  );
  process.stdout.write(
    `${'-'.repeat(nameWidth)}-+-${'-'.repeat(9)}-+-${'-'.repeat(9)}-+-${'-'.repeat(9)}`
    + `-+--------+--------\n`,
  );
  for (const row of measurements) {
    process.stdout.write(
      `${pad(row.name, nameWidth)} | ${padStart(row.p50Ms.toFixed(3), 9)}`
      + ` | ${padStart(row.p95Ms.toFixed(3), 9)} | ${padStart(String(row.budgetMs), 9)}`
      + ` | ${pad(String(row.iterations), 6)} | ${row.p95Ms > row.budgetMs ? 'MISSED' : 'ok'}\n`,
    );
  }
}

async function main(): Promise<void> {
  const root = readStringArg(process.argv.slice(2), '--root', DEFAULT_BENCH_ROOT);
  const context = openBench(root);
  try {
    const owner = context.graph.nodes.findByCanonicalKey(
      OWNER_ID, 'person', OWNER_PERSON_CANONICAL_KEY,
    );
    if (owner === null) {
      throw new Error(`No seeded owner in ${context.root}. Run npm run bench:assistant:seed first.`);
    }
    const assertionIds = context.graph.assertions
      .listBySubject(OWNER_ID, owner.id, ['active'])
      .slice(0, DEFAULT_ITERATIONS)
      .map((row) => row.id);
    if (assertionIds.length === 0) {
      throw new Error(`No seeded assertions in ${context.root}.`);
    }

    const retriever = new MemoryRetriever(
      context.graph,
      new EstimateTokenCounter(4),
      DEFAULT_ASSISTANT_CONFIG.Retrieval,
      context.graph.retrievalUsage,
    );
    const captureQueue = new CaptureQueueStore(context.database, context.clock);
    const pixels = Buffer.alloc(CAPTURE_PIXEL_BYTES);
    for (let index = 0; index < pixels.byteLength; index += 4_096) {
      pixels[index] = index % 251;
    }
    const activityConfig = {
      ...DEFAULT_ASSISTANT_CONFIG,
      Enabled: true,
      Observation: { ...DEFAULT_ASSISTANT_CONFIG.Observation, ActivityMetadataEnabled: true },
    };
    const sinceUtc = new Date(Date.now() - 86_400_000).toISOString();

    const measurements = [
      await measure('Graph lookup', 50, DEFAULT_ITERATIONS, (index) => {
        context.graph.assertions.getAssertion(assertionIds[index % assertionIds.length] ?? '');
      }),
      await measure('Tier 1 load', 20, DEFAULT_ITERATIONS, () => {
        const profile = context.graph.projections.findByTopic(OWNER_ID, 1, 'profile');
        if (profile !== null) void profile.content.length;
      }),
      await measure('Retrieval', 150, RETRIEVAL_ITERATIONS, async (index) => {
        await retriever.retrieve({
          ownerId: OWNER_ID,
          userMessage: `which tools do I use for Bench Tool ${index % 2_000}?`,
          conversationId: null,
          recordUsage: false,
        });
      }),
      // The only writing measurement: each run appends its own activity rows, so a seeded root
      // grows slightly with every benchmark. Re-seed when comparing runs.
      await measure('Activity ingestion', 10, DEFAULT_ITERATIONS, (index) => {
        context.activity.ingest(
          OWNER_ID, activityEvent(index, new Date().toISOString()), activityConfig,
        );
      }),
      await measure('Capture dedupe', 250, DEFAULT_ITERATIONS, () => {
        captureQueue.findByPixelSha(OWNER_ID, hashBytes(pixels), sinceUtc);
      }),
    ];

    process.stdout.write(`assistant §19.5 benchmark — ${context.root}\n`);
    report(measurements);
    const missed = measurements.filter((row) => row.p95Ms > row.budgetMs);
    process.stdout.write(
      missed.length === 0
        ? 'every measurement is inside its budget\n'
        : `MISSED: ${missed.map((row) => row.name).join(', ')}\n`,
    );
  } finally {
    closeRuntimeDatabase();
  }
}

await main();
