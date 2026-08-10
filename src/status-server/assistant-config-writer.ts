import type { AssistantConfigWriter } from '../assistant/assistant-service.js';
import type { AssistantConfig } from '../config/types.js';
import { readConfig, writeConfig } from './config-store.js';

/**
 * Persists an assistant config block through the same store the config route uses, so a flip the
 * service makes itself (key custody) survives a restart exactly like a user edit.
 */
export class StatusServerAssistantConfigWriter implements AssistantConfigWriter {
  constructor(private readonly configPath: string) {}

  write(assistant: AssistantConfig): void {
    writeConfig(this.configPath, { ...readConfig(this.configPath), Assistant: assistant });
  }
}
