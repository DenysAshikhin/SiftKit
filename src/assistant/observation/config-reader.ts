import type { AssistantConfig } from '../../config/types.js';

/** Live view of the assistant config block. Observation gates re-read it on every ingestion. */
export interface AssistantConfigReader {
  read(): AssistantConfig;
}

/**
 * The gate every desktop ingestion path shares: nothing the shell reports is accepted while the
 * assistant is off or private mode is on, and the failure is loud so the shell can stop capturing.
 */
export function requireObservationAllowed(config: AssistantConfig): void {
  if (!config.Enabled) {
    throw new Error('Assistant is disabled; desktop observation is not accepted.');
  }
  if (config.PrivateMode.Active) {
    throw new Error('Private mode is active; desktop observation is not accepted.');
  }
}
