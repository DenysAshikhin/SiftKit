import { presetAcceptsImages } from '../llm-protocol/image-attachments.js';
import type {
  AssistantImageCapability, AssistantImageCapabilityProvider,
} from '../assistant/images/image-capability.js';
import type { AppliedModelPresetState } from './applied-model-preset-state.js';
import type { PresetRuntimeCoordinator } from './preset-runtime-coordinator.js';

/**
 * Reports whether the live runtime can analyse an image right now. Deliberately read-only: the
 * image queue may never start, switch, or keep a model alive — it only ever asks (spec §5).
 */
export class ManagedRuntimeImageCapabilityProvider implements AssistantImageCapabilityProvider {
  constructor(
    private readonly runtimes: Pick<PresetRuntimeCoordinator, 'getActiveRuntime'>,
    private readonly appliedPreset: AppliedModelPresetState,
  ) {}

  read(): AssistantImageCapability {
    const runtime = this.runtimes.getActiveRuntime();
    const running = runtime.getProcessState() === 'ready' && runtime.getModelState() === 'ready';
    return {
      instanceId: running ? `${runtime.id}:${runtime.getGeneration()}` : null,
      visionCapable: running && presetAcceptsImages(this.appliedPreset.getPreset()),
      healthy: running,
    };
  }
}
