import type { ModelResidencyGate } from '../assistant/jobs/job-runner.ts';
import type { PresetRuntimeCoordinator } from './preset-runtime-coordinator.ts';

/** Holds managed background model work unless the configured runtime is ready. */
export class StatusServerResidencyGate implements ModelResidencyGate {
  private readonly coordinator: Pick<PresetRuntimeCoordinator, 'getStatus'> | null;

  constructor(
    coordinator: Pick<PresetRuntimeCoordinator, 'getStatus'> | null,
  ) {
    this.coordinator = coordinator;
  }

  isModelResident(): boolean {
    return this.coordinator === null || this.coordinator.getStatus().modelState === 'ready';
  }
}
