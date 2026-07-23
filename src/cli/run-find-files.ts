import { findFiles } from '../find-files.js';
import { parseArguments, type ResolvedCliArgs } from './args.js';

export async function runFindFiles(options: ResolvedCliArgs & {
  stdout: NodeJS.WritableStream;
}): Promise<number> {
  const parsed = parseArguments(options.args);
  if (parsed.positionals.length === 0) {
    throw new Error('At least one file name or pattern is required.');
  }

  const results = findFiles(parsed.positionals, parsed.path || '.');
  for (const result of results) {
    options.stdout.write(`${parsed.fullPath ? result.FullPath : result.RelativePath}\n`);
  }
  return 0;
}
