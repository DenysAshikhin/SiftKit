import { hashBytes } from '../../src/assistant/domain/keys.ts';
import { EstimateTokenCounter } from '../../src/assistant/domain/tokens.ts';
import { DEFAULT_ASSISTANT_CONFIG } from '../../src/config/defaults.ts';
import { closeRuntimeDatabase } from '../../src/state/runtime-db.ts';
import { hasPixelCaptureSince } from '../../src/vault/captures.ts';
import { readVaultNote, readVaultNotes } from '../../src/vault/note-rows.ts';
import { findOwnerNote } from '../../src/vault/owner-identity.ts';
import { VaultRetriever } from '../../src/vault/vault-retriever.ts';
import {
  DEFAULT_BENCH_ROOT, OWNER_ID, activityEvent, openBench, readStringArg,
} from './shared.ts';

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
    if (findOwnerNote(context.database) === null) {
      throw new Error(`No seeded owner note in ${context.root}. Run npm run bench:assistant:seed first.`);
    }
    const noteIds = readVaultNotes(
      context.database, `SELECT * FROM vault_notes WHERE kind = 'entity' LIMIT ${DEFAULT_ITERATIONS}`,
    ).map((note) => note.id);
    const retriever = new VaultRetriever({ database: context.database, tokens: new EstimateTokenCounter(4) });
    const limits = {
      maxContextTokens: DEFAULT_ASSISTANT_CONFIG.Retrieval.MaxContextTokens,
      maxNotes: DEFAULT_ASSISTANT_CONFIG.Retrieval.MaxNotes,
    };
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
      await measure('Note lookup', 50, DEFAULT_ITERATIONS, (index) => {
        readVaultNote(context.database, noteIds[index % noteIds.length] ?? '');
      }),
      await measure('Owner note load', 20, DEFAULT_ITERATIONS, () => {
        findOwnerNote(context.database);
      }),
      await measure('Retrieval', 150, RETRIEVAL_ITERATIONS, async (index) => {
        await retriever.retrieve(`which tools do I use for Bench Tool ${index % noteIds.length}?`, limits);
      }),
      // The only writing measurement: each run appends its own activity rows, so a seeded root
      // grows slightly with every benchmark. Re-seed when comparing runs.
      await measure('Activity ingestion', 10, DEFAULT_ITERATIONS, (index) => {
        context.activity.ingest(
          OWNER_ID, activityEvent(index, new Date().toISOString()), activityConfig,
        );
      }),
      await measure('Capture dedupe', 250, DEFAULT_ITERATIONS, () => {
        hasPixelCaptureSince(context.database, hashBytes(pixels), sinceUtc);
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
    closeRuntimeDatabase(context.database.name);
  }
}

await main();
