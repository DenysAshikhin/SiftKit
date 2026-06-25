// Benchmark module public API barrel.

import { getErrorMessage } from '../../src/lib/errors.js';

export { main, runBenchmarkSuite } from './runner.js';
export type {
  BenchmarkCaseResult,
  BenchmarkRunResult,
  BenchmarkRunnerOptions,
} from './types.js';

if (require.main === module) {
  void import('./runner.js').then(({ main: run }) =>
    run().catch((error) => {
      process.stderr.write(`${getErrorMessage(error)}\n`);
      process.exit(1);
    })
  );
}
