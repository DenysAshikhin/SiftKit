import {
  AssistantBackgroundWorkDecisionDtoSchema,
  PENDING_CAPTURE_LIST_STATES,
  type AssistantBackgroundWorkBlock,
  type AssistantBackgroundWorkDecisionDto,
} from '@siftkit/contracts';
import { z } from '../../lib/zod.js';
import { parseJsonText } from '../../lib/json.js';
import type { RuntimeDatabase } from '../../state/runtime-db.js';
import type { Clock } from '../clock.js';
import { ASSISTANT_METADATA_PREFIX } from './schema.js';

const HISTORY_LIMIT = 100;
const METADATA_KEY = `${ASSISTANT_METADATA_PREFIX}background_work_decisions.v1`;
const PersistedHistoriesSchema = z.record(
  z.string(),
  z.array(AssistantBackgroundWorkDecisionDtoSchema).max(HISTORY_LIMIT),
);
const MetadataValueRowSchema = z.object({ value: z.string() }).strict();
const CountRowSchema = z.object({ count: z.number().int().min(0) }).strict();
const CAPTURE_STATE_PLACEHOLDERS = PENDING_CAPTURE_LIST_STATES.map(
  () => '?',
).join(', ');

export class BackgroundWorkDecisionStore {
  constructor(
    private readonly database: RuntimeDatabase,
    private readonly clock: Clock,
  ) {}

  record(ownerId: string, block: AssistantBackgroundWorkBlock): void {
    const queuedJobCount = this.countQueuedJobs(ownerId);
    const pendingCaptureCount = this.countPendingCaptures(ownerId);
    if (queuedJobCount === 0 && pendingCaptureCount === 0) return;

    const decision = AssistantBackgroundWorkDecisionDtoSchema.parse({
      recordedAtUtc: this.clock.nowUtc(),
      reason: block.reason,
      queuedJobCount,
      pendingCaptureCount,
      details: block.details,
    });
    this.database.transaction(() => {
      const histories = this.readAll();
      const ownerHistory = histories[ownerId] ?? [];
      const updated = PersistedHistoriesSchema.parse({
        ...histories,
        [ownerId]: [...ownerHistory, decision].slice(-HISTORY_LIMIT),
      });
      this.database
        .prepare(
          `
        INSERT INTO runtime_metadata (key, value, updated_at_utc)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at_utc = excluded.updated_at_utc
      `,
        )
        .run(METADATA_KEY, JSON.stringify(updated), this.clock.nowUtc());
    })();
  }

  list(ownerId: string): AssistantBackgroundWorkDecisionDto[] {
    return [...(this.readAll()[ownerId] ?? [])].reverse();
  }

  private readAll(): z.infer<typeof PersistedHistoriesSchema> {
    const row = this.database
      .prepare('SELECT value FROM runtime_metadata WHERE key = ?')
      .get(METADATA_KEY);
    if (row === undefined || row === null) return {};
    return parseJsonText(
      MetadataValueRowSchema.parse(row).value,
      PersistedHistoriesSchema,
    );
  }

  private countQueuedJobs(ownerId: string): number {
    return CountRowSchema.parse(
      this.database
        .prepare(
          `
      SELECT COUNT(*) AS count FROM assistant_jobs WHERE owner_id = ? AND status = 'queued'
    `,
        )
        .get(ownerId),
    ).count;
  }

  private countPendingCaptures(ownerId: string): number {
    return CountRowSchema.parse(
      this.database
        .prepare(
          `
      SELECT COUNT(*) AS count FROM assistant_capture_queue
      WHERE owner_id = ? AND state IN (${CAPTURE_STATE_PLACEHOLDERS})
    `,
        )
        .get(ownerId, ...PENDING_CAPTURE_LIST_STATES),
    ).count;
  }
}
