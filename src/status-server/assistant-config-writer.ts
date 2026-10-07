import type { KeyCustody } from '@siftkit/contracts';
import type { AssistantConfigWriter } from '../assistant/assistant-service.ts';
import type { AssistantConfig } from '../config/types.ts';
import { readConfig, writeConfig } from './config-store.ts';

/**
 * Persists an assistant custody flip through the same store the config route uses, so a flip the
 * service makes itself survives a restart exactly like a user edit. The Assistant block is taken
 * from the store, not from the caller, so concurrent config saves are never overwritten.
 */
export class StatusServerAssistantConfigWriter implements AssistantConfigWriter {
  private readonly configPath: string;

  constructor(configPath: string) {
    this.configPath = configPath;
  }

  writeKeyCustody(custody: KeyCustody): AssistantConfig {
    const config = readConfig(this.configPath);
    const assistant = { ...config.Assistant, KeyCustody: custody };
    writeConfig(this.configPath, { ...config, Assistant: assistant });
    return assistant;
  }
}
