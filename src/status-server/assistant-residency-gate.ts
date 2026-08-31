import type { ModelResidencyGate } from '../assistant/jobs/job-runner.js';
import type { PresetRuntimeCoordinator } from './preset-runtime-coordinator.js';

/** Holds managed background model work unless the configured runtime is ready. */
export class StatusServerResidencyGate implements ModelResidencyGate {
  constructor(
    private readonly coordinator: Pick<PresetRuntimeCoordinator, 'getStatus'> | null,
  ) {}

  isModelResident(): boolean {
    return this.coordinator === null || this.coordinator.getStatus().modelState === 'ready';
  }
}
