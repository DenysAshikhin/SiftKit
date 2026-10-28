import type { Clock } from '../assistant/clock.ts';
import type { JobStore } from '../assistant/storage/job-store.ts';
import type { AssistantConfig } from '../config/types.ts';
import type { RuntimeDatabase } from '../state/runtime-db.ts';
import { captureRetentionLimits, type VaultCaptureRetention } from './capture-retention.ts';
import type { VaultDailyRollup } from './note-writer/daily-rollup.ts';
import { clearRollupDay, listRollupDays } from './rollup-days.ts';
import type { VaultValidationQueue } from './validation-queue.ts';

export interface VaultMaintenanceOptions {
  readonly database: RuntimeDatabase;
  readonly retention: VaultCaptureRetention;
  readonly rollup: VaultDailyRollup;
  readonly queue: VaultValidationQueue;
  readonly jobs: JobStore;
  readonly clock: Clock;
}

/** The one deterministic vault job: retention, pending rollups, then the review trigger. */
export class VaultMaintenance {
  private readonly options: VaultMaintenanceOptions;

  constructor(options: VaultMaintenanceOptions) {
    this.options = options;
  }

  run(ownerId: string, config: AssistantConfig): void {
    const { database, retention, rollup, queue, jobs, clock } = this.options;
    retention.run(ownerId, captureRetentionLimits(config));
    for (const day of listRollupDays(database)) {
      database.transaction(() => {
        rollup.run(day);
        clearRollupDay(database, day);
      })();
    }
    // Captures and chats go first; the review key keeps at most one review live.
    if (jobs.countQueued(ownerId, 'vault_write') > 0) return;
    const noteIds = queue.nextBatch(clock.nowUtc());
    if (noteIds.length > 0) jobs.enqueue(ownerId, { jobType: 'vault_write', payload: { source: 'review', noteIds } }, config.Background.JobPriorities);
  }
}
