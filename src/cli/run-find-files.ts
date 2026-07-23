import { findFiles } from '../find-files.js';
import { parseArguments } from './args.js';
import { CLI_COMMAND_CATALOG } from './command-catalog.js';

export async function runFindFiles(options: {
  argv: string[];
  stdout: NodeJS.WritableStream;
}): Promise<number> {
  const parsed = parseArguments(CLI_COMMAND_CATALOG.resolve(options.argv).args);
  if (parsed.positionals.length === 0) {
    throw new Error('At least one file name or pattern is required.');
  }

  const results = findFiles(parsed.positionals, parsed.path || '.');
  for (const result of results) {
    options.stdout.write(`${parsed.fullPath ? result.FullPath : result.RelativePath}\n`);
  }
  return 0;
}
