import type { PowerShellRunner } from '../../src/status-server/arsenal-ram-disk-driver.ts';

/** Records each script and answers with a scripted result; never starts PowerShell. */
export class RecordingRunner implements PowerShellRunner {
  readonly runs: Array<{ script: string; job: Record<string, string | number>; admin: boolean }> = [];
  private readonly results: string[];
  constructor(results: string[]) {
    this.results = results;
  }
  async run(script: string, job: Record<string, string | number>, admin: boolean): Promise<string> {
    this.runs.push({ script, job, admin });
    return this.results.shift() ?? 'null';
  }
}
