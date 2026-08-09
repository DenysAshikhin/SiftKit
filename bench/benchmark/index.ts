// Benchmark module public API barrel.

import { getErrorMessage } from '../../src/lib/errors.js';
import { isMainModule } from '../../src/lib/paths.js';

export { main, runBenchmarkSuite } from './runner.js';
export type {
  BenchmarkCaseResult,
  BenchmarkRunResult,
  BenchmarkRunnerOptions,
} from './types.js';

if (isMainModule(import.meta.url)) {
  void import('./runner.js').then(({ main: run }) =>
    run().catch((error) => {
      process.stderr.write(`${getErrorMessage(error)}\n`);
      process.exit(1);
    })
  );
}
