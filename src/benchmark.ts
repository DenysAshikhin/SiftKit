export { main, runBenchmarkSuite } from './benchmark/index.js';
export type {
  BenchmarkCaseResult,
  BenchmarkRunResult,
  BenchmarkRunnerOptions,
} from './benchmark/index.js';

if (require.main === module) {
  void import('./benchmark/index.js').then(({ main }) =>
    main().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`${message}\n`);
      process.exit(1);
    })
  );
}
