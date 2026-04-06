// CLI module public API barrel.

export { runCli } from './dispatch.js';
export type { CliRunOptions } from './args.js';

if (require.main === module) {
  void (async () => {
    let stdinText = '';
    if (!process.stdin.isTTY) {
      stdinText = await new Promise<string>((resolve, reject) => {
        let collected = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', (chunk: string) => {
          collected += chunk;
        });
        process.stdin.on('end', () => resolve(collected));
        process.stdin.on('error', reject);
      });
    }

    const { runCli: run } = await import('./dispatch.js');
    const exitCode = await run({
      argv: process.argv.slice(2),
      stdinText,
    });
    process.exit(exitCode);
  })();
}
