import type { InferenceBackendId } from '../config/types.js';
import type { BackendSelectionStore } from './backend-switch-coordinator.js';
import { readConfig, writeConfig } from './config-store.js';

export class ConfigBackendSelectionStore implements BackendSelectionStore {
  constructor(private readonly configPath: string) {}

  getSelectedBackend(): InferenceBackendId {
    return readConfig(this.configPath).Inference.SelectedBackend;
  }

  saveSelectedBackend(backend: InferenceBackendId): void {
    const config = readConfig(this.configPath);
    config.Inference.SelectedBackend = backend;
    writeConfig(this.configPath, config);
  }
}
