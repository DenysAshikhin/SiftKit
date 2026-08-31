import type {
  InteractivityGate, ModelResidencyGate,
} from '../../src/assistant/jobs/job-runner.js';

/** The host is always quiet, so every drain in these suites is allowed to claim. */
export const ALWAYS_IDLE = {
  isIdle(): boolean {
    return true;
  },
} satisfies InteractivityGate;

/** These suites never exercise residency; the model is treated as loaded throughout. */
export const ALWAYS_RESIDENT = {
  isModelResident(): boolean {
    return true;
  },
} satisfies ModelResidencyGate;
