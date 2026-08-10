/**
 * Whether a vision-capable model is live right now. `instanceId` changes on every runtime state
 * transition, so a job can prove the runtime it was admitted against is still the one it calls.
 */
export interface AssistantImageCapability {
  readonly instanceId: string | null;
  readonly visionCapable: boolean;
  readonly healthy: boolean;
}

export interface AssistantImageCapabilityProvider {
  read(): AssistantImageCapability;
}

/** A capability reading that can actually carry an image extraction: a live, identified runtime. */
export interface UsableImageCapability extends AssistantImageCapability {
  readonly instanceId: string;
  readonly visionCapable: true;
  readonly healthy: true;
}

/**
 * The one definition of "an image can be analysed right now". Queue admission, drain enqueueing,
 * and job dispatch all ask this, so none of them can accept a state another one rejects.
 */
export function isUsableCapability(
  capability: AssistantImageCapability,
): capability is UsableImageCapability {
  return capability.visionCapable && capability.healthy && capability.instanceId !== null;
}

/** Headless composition — no managed runtime is attached, so nothing is capable. */
export class UnavailableImageCapabilityProvider implements AssistantImageCapabilityProvider {
  read(): AssistantImageCapability {
    return { instanceId: null, visionCapable: false, healthy: false };
  }
}
