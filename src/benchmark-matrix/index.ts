// Benchmark-matrix module public API barrel.

export { buildBenchmarkArgs, buildLaunchSignature, buildLauncherArgs } from './launcher.js';
export { readMatrixManifest } from './manifest.js';
export { pruneOldLauncherLogs } from './pruning.js';
export { main, runMatrix, runMatrixWithInterrupt } from './runner.js';

if (require.main === module) {
  void import('./runner.js').then(({ main: run }) =>
    run().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`${message}\n`);
      process.exit(1);
    })
  );
}
