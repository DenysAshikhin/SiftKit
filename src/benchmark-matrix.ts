import { buildBenchmarkArgs, buildLaunchSignature, buildLauncherArgs } from './benchmark-matrix/launcher.js';
import { readMatrixManifest } from './benchmark-matrix/manifest.js';
import { pruneOldLauncherLogs } from './benchmark-matrix/pruning.js';
import { main, runMatrix, runMatrixWithInterrupt } from './benchmark-matrix/runner.js';

export {
  buildBenchmarkArgs,
  buildLaunchSignature,
  buildLauncherArgs,
  pruneOldLauncherLogs,
  readMatrixManifest,
  runMatrix,
  runMatrixWithInterrupt,
};

if (require.main === module) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
}
