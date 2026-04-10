// CLI module public API barrel.

export { runCli } from './dispatch.js';
export type { CliRunOptions } from './args.js';

if (require.main === module) {
  void (async () => {
    let stdinText: Buffer | undefined;
    if (!process.stdin.isTTY) {
      stdinText = await new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = [];
        process.stdin.on('data', (chunk: Buffer | string) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        process.stdin.on('end', () => resolve(Buffer.concat(chunks)));
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
