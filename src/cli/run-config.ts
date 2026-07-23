import { loadConfig, setTopLevelConfigKey } from '../config/index.js';
import { parseArguments } from './args.js';

export async function runConfigGet(stdout: NodeJS.WritableStream): Promise<number> {
  const config = await loadConfig({ ensure: true });
  stdout.write(`${JSON.stringify(config, null, 2)}\n`);
  return 0;
}

export async function runConfigSet(options: {
  args: string[];
  stdout: NodeJS.WritableStream;
}): Promise<number> {
  const parsed = parseArguments(options.args);
  if (!parsed.key) {
    throw new Error('A --key is required.');
  }
  const config = await setTopLevelConfigKey(parsed.key, parsed.value ?? null);
  options.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
  return 0;
}
