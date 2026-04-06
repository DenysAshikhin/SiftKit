// Benchmark module public API barrel.

export { main, runBenchmarkSuite } from './runner.js';
export type {
  BenchmarkCaseResult,
  BenchmarkRunResult,
  BenchmarkRunnerOptions,
} from './types.js';

if (require.main === module) {
  void import('./runner.js').then(({ main: run }) =>
    run().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`${message}\n`);
      process.exit(1);
    })
  );
}
