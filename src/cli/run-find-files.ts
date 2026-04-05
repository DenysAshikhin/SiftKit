import { findFiles } from '../find-files.js';
import { getCommandArgs, parseArguments } from './args.js';

export async function runFindFiles(options: {
  argv: string[];
  stdout: NodeJS.WritableStream;
}): Promise<number> {
  const parsed = parseArguments(getCommandArgs(options.argv));
  if (parsed.positionals.length === 0) {
    throw new Error('At least one file name or pattern is required.');
  }

  const results = findFiles(parsed.positionals, parsed.path || '.');
  for (const result of results) {
    options.stdout.write(`${parsed.fullPath ? result.FullPath : result.RelativePath}\n`);
  }
  return 0;
}
