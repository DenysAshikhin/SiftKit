// CLI module public API barrel.

export { runCli } from './dispatch.js';
export type { CliRunOptions } from './args.js';
import { commandReadsStdin, readStdinToEnd } from './stdin-input.js';
import { isMainModule } from '../lib/paths.js';

if (isMainModule(import.meta.url)) {
  void (async () => {
    const argv = process.argv.slice(2);
    let stdinText: string | undefined;
    if (!process.stdin.isTTY && commandReadsStdin(argv)) {
      stdinText = (await readStdinToEnd(process.stdin)).text;
    }

    const { runCli: run } = await import('./dispatch.js');
    const exitCode = await run({
      argv,
      stdinText,
      stdin: process.stdin,
    });
    process.exit(exitCode);
  })();
}
