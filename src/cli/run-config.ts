import { loadConfig, setTopLevelConfigKey } from '../config/index.js';
import { parseArguments } from './args.js';
import { CLI_COMMAND_CATALOG } from './command-catalog.js';

export async function runConfigGet(stdout: NodeJS.WritableStream): Promise<number> {
  const config = await loadConfig({ ensure: true });
  stdout.write(`${JSON.stringify(config, null, 2)}\n`);
  return 0;
}

export async function runConfigSet(options: {
  argv: string[];
  stdout: NodeJS.WritableStream;
}): Promise<number> {
  const parsed = parseArguments(CLI_COMMAND_CATALOG.resolve(options.argv).args);
  if (!parsed.key) {
    throw new Error('A --key is required.');
  }
  const config = await setTopLevelConfigKey(parsed.key, parsed.value ?? null);
  options.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
  return 0;
}
