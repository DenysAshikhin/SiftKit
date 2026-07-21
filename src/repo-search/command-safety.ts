// ---------------------------------------------------------------------------
// Ignore policy — hardcoded common dependency/build directories
// ---------------------------------------------------------------------------

const BASELINE_IGNORED_NAMES = [
  // Version control
  '.git', '.claude',
  // JavaScript / Node
  'node_modules', '.node_modules', '.npm-cache', '.npm', '.pnpm-store', '.yarn',
  // Python
  '__pycache__', '.venv', 'venv', '.env', '.tox', '.pytest_cache', '.mypy_cache',
  // Ruby
  '.bundle', 'vendor',
  // Java / Kotlin / Scala
  'target',
  // Rust
  // (also 'target', already included above)
  // Go
  'pkg',
  // Build outputs
  'dist', 'build', 'out', 'coverage', '.cache',
  // Misc tooling
  'bower_components', '.parcel-cache', '.next', '.nuxt', '.svelte-kit',
  // Gradle
  '.gradle', '.gradle-user-home-local', '.gradle-user-home', '.gradle-native', '.gradle-native-test',
  // Project-specific
  'thinking_bench',
];

// Root-relative path prefixes (forward-slash separated, no leading slash).
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
    namesLower: new Set(names.map((n) => n.toLowerCase())),
    paths: [...BASELINE_IGNORED_PATHS],
  };
}

// ---------------------------------------------------------------------------
// Command safety evaluation
//
// Every repo tool except `git` executes natively from typed args (see
// engine/repo-tools.ts), so `git` is the only command string that ever reaches a
// shell. This gate is what stands between that string and PowerShell.
// ---------------------------------------------------------------------------

export type SafetyResult = {
  safe: boolean;
  reason: string | null;
};

const PRODUCER_COMMAND = 'git';

const READ_ONLY_PIPE_COMMANDS = new Set([
  'select-object', 'select-string', 'where-object', 'sort-object',
  'group-object', 'measure-object', 'foreach-object', 'format-table',
  'format-list', 'out-string', 'convertto-json', 'convertfrom-json',
  'get-unique', 'join-string',
]);

const WRITE_OR_NETWORK_COMMAND_PATTERN = /\b(rm|del|mv|cp|move-item|copy-item|remove-item|set-content|add-content|out-file|export-[a-z0-9_-]+|tee-object|curl|wget|invoke-webrequest|invoke-restmethod|start-process)\b/iu;

const FOREACH_WRITE_COMMAND_PATTERN = /\b(set-content|add-content|out-file|export-[a-z0-9_-]+|tee-object|remove-item|move-item|copy-item|rename-item|invoke-webrequest|invoke-restmethod|start-process)\b/iu;

function hasBlockedOperator(command: string): boolean {
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (ch === '`') {
      return true;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (inSingle || inDouble) {
      continue;
    }
    if (ch === ';' || (ch === '&' && command[i + 1] === '&') || (ch === '|' && command[i + 1] === '|')) {
      return true;
    }
  }

  return false;
}

function hasFileRedirection(command: string): boolean {
  // Strip safe stderr-to-stdout merges (2>&1) before checking for real file redirects
  const withoutStderrMerge = command.replace(/\s*2>&1\s*/gu, ' ');
  return /[<>]/u.test(withoutStderrMerge);
}

function splitTopLevelPipes(command: string): string[] {
  const parts: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      current += ch;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      current += ch;
      continue;
    }
    if (ch === '|' && !inSingle && !inDouble) {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }

  if (current.trim()) {
    parts.push(current.trim());
  }

  return parts;
}

export function getFirstCommandToken(segment: string): string {
  const match = /^\s*(\S+)/u.exec(segment);
  return match ? match[1].toLowerCase() : '';
}

function tokenizeSegment(segment: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i];
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (/\s/u.test(ch) && !inSingle && !inDouble) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }

  if (current) {
    tokens.push(current);
  }

  return tokens;
}

function referencesPathOutsideRepo(command: string, repoRoot: string): boolean {
  if (!repoRoot) return false;
  const repoRootNormalized = repoRoot.replace(/\//gu, '\\').toLowerCase().replace(/\\+$/u, '');
  const tokens = tokenizeSegment(command);
  for (const token of tokens) {
    if (/^[a-zA-Z]:\\/u.test(token)) {
      const tokenNormalized = token.replace(/\//gu, '\\').toLowerCase();
      if (!tokenNormalized.startsWith(repoRootNormalized)) {
        // But allow drive-letter patterns inside regex/string quotes
        // by checking if the token was the actual command path or a search pattern.
        const isLikelyPattern = /[|*?[\]{}()]/u.test(token) || /\\\\/u.test(token);
        if (!isLikelyPattern) {
          return true;
        }
      }
    }
  }
  return false;
}

export function evaluateCommandSafety(command: string, repoRoot = ''): SafetyResult {
  const trimmed = String(command || '').trim();
  if (!trimmed) {
    return { safe: false, reason: 'empty command' };
  }

  if (referencesPathOutsideRepo(trimmed, repoRoot)) {
    return { safe: false, reason: 'command must stay within the caller repository scope' };
  }

  if (hasBlockedOperator(trimmed)) {
    return { safe: false, reason: 'shell chaining/redirection is not allowed' };
  }

  if (hasFileRedirection(trimmed)) {
    return { safe: false, reason: 'file redirection is not allowed' };
  }

  if (WRITE_OR_NETWORK_COMMAND_PATTERN.test(trimmed)) {
    return { safe: false, reason: 'destructive, file-writing, or network command is not allowed' };
  }

  const segments = splitTopLevelPipes(trimmed);
  const producerToken = getFirstCommandToken(segments[0] || '');
  if (producerToken !== PRODUCER_COMMAND) {
    return { safe: false, reason: `command '${producerToken || '<empty>'}' is not in the allow-list` };
  }

  for (const segment of segments.slice(1)) {
    const pipeToken = getFirstCommandToken(segment);
    if (!READ_ONLY_PIPE_COMMANDS.has(pipeToken)) {
      return { safe: false, reason: `command '${pipeToken || '<empty>'}' is not in the allow-list` };
    }
    if (/\bforeach-object\b/iu.test(segment) && FOREACH_WRITE_COMMAND_PATTERN.test(segment)) {
      return { safe: false, reason: 'ForEach-Object must be read-only' };
    }
  }

  return { safe: true, reason: null };
}
