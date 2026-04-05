import { main, runBenchmarkSuite } from './benchmark/runner.js';

export { runBenchmarkSuite };
export type {
  BenchmarkCaseResult,
  BenchmarkRunResult,
  BenchmarkRunnerOptions,
} from './benchmark/types.js';

if (require.main === module) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
}
