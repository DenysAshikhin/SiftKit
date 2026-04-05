import { runCli } from './cli/dispatch.js';

export { runCli };

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

    const exitCode = await runCli({
      argv: process.argv.slice(2),
      stdinText,
    });
    process.exit(exitCode);
  })();
}
