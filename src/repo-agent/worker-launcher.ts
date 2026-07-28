import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { moduleDirname } from '../lib/paths.js';
import { toError } from '../lib/errors.js';
import { z } from '../lib/zod.js';
import { isTerminalStatus } from './run-schemas.js';
import type { RepoAgentRunStore } from './run-store.js';

const ProcessIdSchema = z.number().int().positive();

export function getRepoAgentWorkerEntrypoint(): string {
  return join(moduleDirname(import.meta.url), 'worker-main.js');
}

export class RepoAgentWorkerLauncher {
  private readonly nodeExecutable: string;
  private readonly workerEntrypoint: string;
  private readonly store: RepoAgentRunStore;

  constructor(options: {
    nodeExecutable: string;
    workerEntrypoint: string;
    store: RepoAgentRunStore;
  }) {
    this.nodeExecutable = options.nodeExecutable;
    this.workerEntrypoint = options.workerEntrypoint;
    this.store = options.store;
  }

  launch(runId: string): number {
    try {
      this.assertLaunchFilesExist();
      const child = spawn(
        this.nodeExecutable,
        [this.workerEntrypoint, runId, this.store.getRunsRoot()],
        {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
        },
      );
      const pid = ProcessIdSchema.parse(child.pid);
      child.unref();
      return pid;
    } catch (error) {
      this.recordFailure(runId, toError(error));
      throw error;
    }
  }

  private assertLaunchFilesExist(): void {
    if (!existsSync(this.nodeExecutable)) {
      throw new Error(`Node executable not found: ${this.nodeExecutable}`);
    }
    if (!existsSync(this.workerEntrypoint)) {
      throw new Error(`Worker entrypoint not found: ${this.workerEntrypoint}`);
    }
  }

  private recordFailure(runId: string, error: Error): void {
    const current = this.store.readState(runId);
    if (isTerminalStatus(current.status)) {
      return;
    }
    this.store.transition(runId, current.revision, {
      runId,
      revision: current.revision + 1,
      updatedAtUtc: new Date().toISOString(),
      status: 'failed',
      error: error.message,
    });
  }
}
