import type { InteractivityGate } from '../assistant/jobs/job-runner.js';
import { isIdle } from './server-ops.js';
import type { ServerContext } from './server-types.js';

/** Background assistant work runs only when the server is doing nothing else (§12.4). */
export class StatusServerIdleGate implements InteractivityGate {
  constructor(private readonly ctx: ServerContext) {}

  isIdle(): boolean {
    return isIdle(this.ctx);
  }
}
