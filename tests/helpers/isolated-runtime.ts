import { awaitRepoSearchRunPersistence } from '../../src/repo-search/execute.js';
import { closeRuntimeDatabase } from '../../src/state/runtime-db.js';
import { createManagedTempDir, removeDirectoryWithRetries } from './temp-dirs.js';

/** Isolates cwd-based SQLite storage for tests that execute requests in process. */
export class IsolatedRuntime {
  private originalCwd: string | null = null;
  private tempRoot: string | null = null;

  start(): void {
    if (this.originalCwd !== null) throw new Error('Runtime isolation is already active.');
    this.originalCwd = process.cwd();
    this.tempRoot = createManagedTempDir('siftkit-isolated-runtime-');
    closeRuntimeDatabase();
    process.chdir(this.tempRoot);
  }

  async close(): Promise<void> {
    if (this.originalCwd === null || this.tempRoot === null) throw new Error('Runtime isolation is not active.');
    await awaitRepoSearchRunPersistence();
    closeRuntimeDatabase();
    process.chdir(this.originalCwd);
    await removeDirectoryWithRetries(this.tempRoot);
    this.originalCwd = null;
    this.tempRoot = null;
  }
}
