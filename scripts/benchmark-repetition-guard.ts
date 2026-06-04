import { performance } from 'node:perf_hooks';

type TokenRepetitionDetection = {
  totalTokens: number;
  windowTokens: number;
  periodTokens: number;
  repeatedTokens: string[];
  truncatedText: string;
};

type RepetitionGuardModule = {
  detectRecentTokenRepetition: (text: string) => TokenRepetitionDetection | null;
};

type BenchmarkCase = {
  name: string;
  tokens: number;
  text: string;
};

type BenchmarkResult = {
  name: string;
  tokens: number;
  chars: number;
  iterations: number;
  totalMs: number;
  avgMs: number;
  detected: number;
};

const TOKEN_LENGTHS: number[] = [10, 100, 1_000, 10_000, 50_000, 100_000];
const TARGET_TOKENS_PER_CASE = 1_000_000;
const MIN_ITERATIONS = 25;
const MAX_ITERATIONS = 20_000;

function makeUniqueText(tokens: number): string {
  return Array.from({ length: tokens }, (_, index) => `tok${index}`).join(' ');
}

function makeRepeatedSuffixText(tokens: number): string {
  const prefixTokens = Math.max(0, tokens - 10);
  const prefix = makeUniqueText(prefixTokens);
  const suffix = Array.from({ length: Math.min(tokens, 10) }, () => '</arg_value>').join('');
  return prefix ? `${prefix} ${suffix}` : suffix;
}

function makeStructuralLoopText(tokens: number): string {
  const prefixTokens = Math.max(0, tokens - 10);
  const prefix = makeUniqueText(prefixTokens);
  const suffix = '}]'.repeat(Math.floor(Math.min(tokens, 10) / 2));
  return prefix ? `${prefix} ${suffix}` : suffix;
}

function buildCases(): BenchmarkCase[] {
  return TOKEN_LENGTHS.flatMap((tokens) => [
    { name: 'unique', tokens, text: makeUniqueText(tokens) },
    { name: 'repeated-suffix', tokens, text: makeRepeatedSuffixText(tokens) },
    { name: 'structural-loop', tokens, text: makeStructuralLoopText(tokens) },
  ]);
}

function iterationsFor(tokens: number): number {
  const rawIterations = Math.ceil(TARGET_TOKENS_PER_CASE / Math.max(tokens, 1));
  return Math.min(MAX_ITERATIONS, Math.max(MIN_ITERATIONS, rawIterations));
}

function runCase(
  benchmarkCase: BenchmarkCase,
  detectRecentTokenRepetition: RepetitionGuardModule['detectRecentTokenRepetition'],
): BenchmarkResult {
  const iterations = iterationsFor(benchmarkCase.tokens);
  let detected = 0;

  for (let index = 0; index < 50; index += 1) {
    detectRecentTokenRepetition(benchmarkCase.text);
  }

  const start = performance.now();
  for (let index = 0; index < iterations; index += 1) {
    if (detectRecentTokenRepetition(benchmarkCase.text)) detected += 1;
  }
  const totalMs = performance.now() - start;

  return {
    name: benchmarkCase.name,
    tokens: benchmarkCase.tokens,
    chars: benchmarkCase.text.length,
    iterations,
    totalMs,
    avgMs: totalMs / iterations,
    detected,
  };
}

function formatNumber(value: number): string {
  return value.toLocaleString('en-US');
}

function formatMs(value: number): string {
  return value.toFixed(value >= 10 ? 2 : 4);
}

function printResults(results: BenchmarkResult[]): void {
  process.stdout.write('repetition guard benchmark\n');
  process.stdout.write('detector: detectRecentTokenRepetition, default 10-token window, trigger after >100 tokens\n\n');
  process.stdout.write('| case | tokens | chars | iterations | detected | total_ms | avg_ms |\n');
  process.stdout.write('| --- | ---: | ---: | ---: | ---: | ---: | ---: |\n');
  for (const result of results) {
    process.stdout.write(
      `| ${result.name} | ${formatNumber(result.tokens)} | ${formatNumber(result.chars)} | `
      + `${formatNumber(result.iterations)} | ${formatNumber(result.detected)} | `
      + `${formatMs(result.totalMs)} | ${formatMs(result.avgMs)} |\n`,
    );
  }
}

function guardModulePath(kind: 'dist' | 'src'): string {
  return kind === 'dist'
    ? '../dist/repo-search/repetition-guard.js'
    : '../src/repo-search/repetition-guard.js';
}

async function loadRepetitionGuard(): Promise<RepetitionGuardModule> {
  let lastError: unknown = null;
  for (const modulePath of [guardModulePath('dist'), guardModulePath('src')]) {
    try {
      return await import(modulePath) as RepetitionGuardModule;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function main(): Promise<void> {
  const module = await loadRepetitionGuard();
  const results = buildCases().map((benchmarkCase) => runCase(benchmarkCase, module.detectRecentTokenRepetition));
  printResults(results);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exitCode = 1;
});
