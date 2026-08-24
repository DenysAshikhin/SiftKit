const BASELINE_IGNORED_NAMES = [
  '.git', '.claude',
  'node_modules', '.node_modules', '.npm-cache', '.npm', '.pnpm-store', '.yarn',
  '__pycache__', '.venv', 'venv', '.env', '.tox', '.pytest_cache', '.mypy_cache',
  '.bundle', 'vendor',
  'target',
  'pkg',
  'dist', 'build', 'out', 'coverage', '.cache',
  'bower_components', '.parcel-cache', '.next', '.nuxt', '.svelte-kit',
  '.gradle', '.gradle-user-home-local', '.gradle-user-home', '.gradle-native', '.gradle-native-test',
  'thinking_bench',
];

const BASELINE_IGNORED_PATHS = [
  'eval/results',
  'eval/fixtures',
  'tmp-find',
];

export type IgnorePolicy = {
  names: string[];
  namesLower: Set<string>;
  paths: string[];
};

export function buildIgnorePolicy(_repoRoot: string): IgnorePolicy {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const name of BASELINE_IGNORED_NAMES) {
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  return {
    names,
    namesLower: new Set(names.map((name) => name.toLowerCase())),
    paths: [...BASELINE_IGNORED_PATHS],
  };
}
