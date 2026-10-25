import { DEFAULT_ASSISTANT_CONFIG } from '../../src/config/defaults.ts';
import { closeRuntimeDatabase } from '../../src/state/runtime-db.ts';
import { ensureOwnerNote } from '../../src/vault/owner-identity.ts';
import {
  DEFAULT_BENCH_ROOT, OWNER_ID, activityEvent, formatSeconds, openBench,
  readNumberArg, readStringArg, type BenchContext,
} from './shared.ts';

const ACTIVITY_EVENT_COUNT = 10_000;
const CHUNK_ROWS = 1_000;
const SEED_SOURCE = { actor: 'migration', sourceRef: null } as const;
const SEED_META = { ...SEED_SOURCE, summary: 'benchmark seed' };

/** Runs `work` in transactions of `CHUNK_ROWS` rows, so one BEGIN never spans the seed. */
function inChunks(context: BenchContext, total: number, work: (index: number) => void): void {
  for (let start = 0; start < total; start += CHUNK_ROWS) {
    context.database.transaction(() => {
      for (let index = start; index < Math.min(start + CHUNK_ROWS, total); index += 1) work(index);
    })();
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const root = readStringArg(argv, '--root', DEFAULT_BENCH_ROOT);
  const noteCount = readNumberArg(argv, '--notes', 10_000);
  const context = openBench(root);
  const startedAtMs = Date.now();
  try {
    const owner = ensureOwnerNote(context.notes, context.database, DEFAULT_ASSISTANT_CONFIG.Owner.DisplayName, SEED_SOURCE);

    inChunks(context, noteCount, (index) => {
      const title = `Bench Tool ${index}`;
      if (context.notes.resolve(title) !== null) return;
      context.notes.create({
        title, folder: 'Software', kind: 'entity', types: ['software'], aliases: [], tags: [],
        body: `${title} is a benchmark tool.\n\n**Used by** [[${owner.title}]]\n**Category** bench-${index % 50}`,
      }, SEED_META);
    });
    process.stdout.write(`notes: ${noteCount} (${formatSeconds(startedAtMs)})\n`);

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
    closeRuntimeDatabase(context.database.name);
  }
}

await main();
