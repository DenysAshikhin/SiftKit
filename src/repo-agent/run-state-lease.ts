import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';

import {
  NodeProcessInspector,
  type ProcessInspector,
} from '../lib/process-inspector.ts';
import { parseJsonText } from '../lib/json.ts';
import { z } from '../lib/zod.ts';

const RepoAgentRunStateLeaseOwnerSchema = z.strictObject({
  pid: z.number().int().positive(),
  createdAtUtc: z.string().datetime(),
});

type RepoAgentRunStateLeaseOwner = z.infer<typeof RepoAgentRunStateLeaseOwnerSchema>;

// An unreadable recovery claim has no recorded owner to liveness-check, so a fixed age
// must expire it; a readable claim is decided by its owner process, not by file age.
export const STALE_RECOVERY_CLAIM_MS = 30_000;

function isErrorCode(error: Error, code: string): boolean {
  return 'code' in error
    && String(error.code) === code;
}

export class RepoAgentRunStateLease {
  private readonly lockPath: string;
  private readonly recoveryPath: string;
  private readonly processInspector: ProcessInspector;
  private acquired = false;

  constructor(
    lockPath: string,
    processInspector: ProcessInspector = new NodeProcessInspector(),
  ) {
    this.lockPath = z.string().min(1).parse(lockPath);
    this.recoveryPath = `${this.lockPath}.recovery`;
    this.processInspector = processInspector;
  }

  acquire(): void {
    if (this.acquired) {
      throw new Error('This state lease is already acquired.');
    }
    if (existsSync(this.recoveryPath) || !this.tryCreateLock(this.lockPath)) {
      this.recoverDeadOwner();
    }
    this.acquired = true;
  }

  release(): void {
    if (!this.acquired) {
      throw new Error('Cannot release a state lease that is not acquired.');
    }
    const owner = this.readOwner(this.lockPath);
    if (owner.pid !== process.pid) {
      throw new Error(`State lease is owned by process ${owner.pid}.`);
    }
    rmSync(this.lockPath);
    this.acquired = false;
  }

  private recoverDeadOwner(): void {
    if (!this.tryCreateLock(this.recoveryPath)) {
      const cleared = this.clearStaleRecoveryClaim();
      if (!cleared || !this.tryCreateLock(this.recoveryPath)) {
        throw new Error('A repo-agent state transition is already active.');
      }
    }
    try {
      if (existsSync(this.lockPath)) {
        const owner = this.readOwner(this.lockPath);
        if (this.processInspector.isAlive(owner.pid)) {
          throw new Error(
            `A repo-agent state transition is already active in process ${owner.pid}.`,
          );
        }
        rmSync(this.lockPath);
      }
      if (!this.tryCreateLock(this.lockPath)) {
        throw new Error('A repo-agent state transition is already active.');
      }
    } finally {
      rmSync(this.recoveryPath, { force: true });
    }
  }

  // Removes the existing recovery claim when its owner is gone or its unreadable age
  // outlived the stale bound; returns false while the claim must win and we fail closed.
  private clearStaleRecoveryClaim(): boolean {
    const owner = this.tryReadOwner(this.recoveryPath);
    if (owner !== null) {
      if (this.processInspector.isAlive(owner.pid)) return false;
    } else if (this.claimAgeMs(this.recoveryPath) < STALE_RECOVERY_CLAIM_MS) {
      return false; // A fresh unreadable claim may still be mid-write.
    }
    rmSync(this.recoveryPath, { force: true });
    return true;
  }

  private tryReadOwner(filePath: string): RepoAgentRunStateLeaseOwner | null {
    try {
      return this.readOwner(filePath);
    } catch {
      return null;
    }
  }

  /** Infinity once the claim has vanished, so the caller's retry recreates it. */
  private claimAgeMs(filePath: string): number {
    const stat = statSync(filePath, { throwIfNoEntry: false });
    return stat === undefined ? Number.POSITIVE_INFINITY : Date.now() - stat.mtimeMs;
  }

  private tryCreateLock(filePath: string): boolean {
    let descriptor: number | undefined;
    try {
      descriptor = openSync(filePath, 'wx');
      writeFileSync(descriptor, `${JSON.stringify({
        pid: process.pid,
        createdAtUtc: new Date().toISOString(),
      })}\n`, 'utf8');
      closeSync(descriptor);
      descriptor = undefined;
      return true;
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      if (descriptor !== undefined) {
        closeSync(descriptor);
        rmSync(filePath, { force: true });
      }
      if (isErrorCode(failure, 'EEXIST')) {
        return false;
      }
      throw failure;
    }
  }

  private readOwner(filePath: string): RepoAgentRunStateLeaseOwner {
    try {
      return parseJsonText(
        readFileSync(filePath, 'utf8'),
        RepoAgentRunStateLeaseOwnerSchema,
      );
    } catch {
      throw new Error(`Malformed state lease: ${filePath}`);
    }
  }
}
