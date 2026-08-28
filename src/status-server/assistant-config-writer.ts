import type { KeyCustody } from '@siftkit/contracts';
import type { AssistantConfigWriter } from '../assistant/assistant-service.js';
import type { AssistantConfig } from '../config/types.js';
import { readConfig, writeConfig } from './config-store.js';

/**
 * Persists an assistant custody flip through the same store the config route uses, so a flip the
 * service makes itself survives a restart exactly like a user edit. The Assistant block is taken
 * from the store, not from the caller, so concurrent config saves are never overwritten.
 */
export class StatusServerAssistantConfigWriter implements AssistantConfigWriter {
  constructor(private readonly configPath: string) {}

  writeKeyCustody(custody: KeyCustody): AssistantConfig {
    const config = readConfig(this.configPath);
    const assistant = { ...config.Assistant, KeyCustody: custody };
    writeConfig(this.configPath, { ...config, Assistant: assistant });
    return assistant;
  }
}
