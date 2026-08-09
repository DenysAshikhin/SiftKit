// Benchmark-matrix module public API barrel.

import { getErrorMessage } from '../../src/lib/errors.js';
import { isMainModule } from '../../src/lib/paths.js';

export { buildBenchmarkArgs, buildLaunchSignature, buildLauncherArgs } from './launcher.js';
export { readMatrixManifest } from './manifest.js';
export { pruneOldLauncherLogs } from './pruning.js';
export { main, runMatrix, runMatrixWithInterrupt } from './runner.js';

if (isMainModule(import.meta.url)) {
  void import('./runner.js').then(({ main: run }) =>
    run().catch((error) => {
      process.stderr.write(`${getErrorMessage(error)}\n`);
      process.exit(1);
    })
  );
}
