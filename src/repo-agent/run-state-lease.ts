import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';

import {
  NodeProcessInspector,
  type ProcessInspector,
} from '../lib/process-inspector.js';
import { parseJsonText } from '../lib/json.js';
import { z } from '../lib/zod.js';

const RepoAgentRunStateLeaseOwnerSchema = z.strictObject({
  pid: z.number().int().positive(),
  createdAtUtc: z.string().datetime(),
});

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
      if (!this.tryCreateLock(this.lockPath)) {
        throw new Error('A repo-agent state transition is already active.');
      }
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
      throw new Error('A repo-agent state transition is already active.');
    }
    try {
      const owner = this.readOwner(this.lockPath);
      if (this.processInspector.isAlive(owner.pid)) {
        throw new Error(
          `A repo-agent state transition is already active in process ${owner.pid}.`,
        );
      }
      rmSync(this.lockPath);
    } finally {
      rmSync(this.recoveryPath, { force: true });
    }
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

  private readOwner(filePath: string): z.infer<
    typeof RepoAgentRunStateLeaseOwnerSchema
  > {
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
