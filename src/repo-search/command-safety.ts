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

const READ_ONLY_GIT_SUBCOMMANDS = new Set([
  'status', 'log', 'show', 'diff', 'blame', 'grep', 'ls-files', 'ls-tree',
  'cat-file', 'rev-parse', 'rev-list', 'describe', 'shortlog', 'reflog',
  'show-ref', 'for-each-ref', 'merge-base', 'name-rev', 'count-objects',
  'diff-tree', 'diff-index', 'check-ignore',
]);

/** Git global flags whose value arrives as the next token (`-C <path>`, `-c <key>=<value>`). */
const GIT_FLAGS_WITH_SEPARATE_VALUE = new Set(['-C', '-c']);

/** First non-flag token after `git` — flag values are skipped so an alias defined via `-c` cannot smuggle a subcommand. */
function findGitSubcommand(producerTokens: string[]): string | null {
  for (let index = 1; index < producerTokens.length; index += 1) {
    const token = producerTokens[index];
    if (GIT_FLAGS_WITH_SEPARATE_VALUE.has(token)) {
      index += 1;
      continue;
    }
    if (token.startsWith('-')) continue;
    return token.toLowerCase();
  }
  return null;
}

type QuoteBlanking = { single: boolean; double: boolean };

/**
 * Replaces the interior of selected quoted spans with spaces, preserving length and quote
 * characters, so a scan sees only the shell syntax that can actually execute. Single-quoted spans
 * are literal in PowerShell; double-quoted spans still expand `$(...)` and honour the backtick
 * escape, but redirection and chaining operators inside them are inert text.
 */
function blankQuotedSpans(command: string, blanking: QuoteBlanking): string {
  let result = '';
  let inSingle = false;
  let inDouble = false;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (char === "'" && !inDouble) {
      inSingle = !inSingle;
      result += char;
      continue;
    }
    if (char === '"' && !inSingle) {
      inDouble = !inDouble;
      result += char;
      continue;
    }
    const shouldBlank = (inSingle && blanking.single) || (inDouble && blanking.double);
    result += shouldBlank ? ' ' : char;
  }
  return result;
}

function hasBlockedOperator(operatorScan: string): boolean {
  let braceDepth = 0;
  for (let index = 0; index < operatorScan.length; index += 1) {
    const char = operatorScan[index];
    if (char === '{') {
      braceDepth += 1;
      continue;
    }
    if (char === '}') {
      // Clamp so an unmatched `}` cannot drive the depth negative and unlock the `;` check.
      braceDepth = Math.max(0, braceDepth - 1);
      continue;
    }
    if (char === ';' && braceDepth === 0) {
      return true;
    }
    // `&` is the call/background/chaining operator everywhere except a `>&` stream merge (2>&1).
    if (char === '&' && operatorScan[index - 1] !== '>') {
      return true;
    }
    if (char === '|' && operatorScan[index + 1] === '|') {
      return true;
    }
  }
  return false;
}

function hasFileRedirection(operatorScan: string): boolean {
  // Strip safe stderr-to-stdout merges (2>&1) before checking for real file redirects
  return /[<>]/u.test(operatorScan.replace(/\s*2>&1\s*/gu, ' '));
}

function hasShellExpansion(expansionScan: string): boolean {
  return expansionScan.includes('`') || expansionScan.includes('$(');
}

/**
 * Bodies of `{ ... }` and `( ... )` groups — the places a command invocation can hide behind an
 * allow-listed pipeline stage. Operates on the fully quote-blanked scan: quoted braces/parens are
 * literal text, and anything executable inside double quotes needs `$(`/backtick, blocked separately.
 */
function extractBracketBodies(operatorScan: string): string[] {
  const bodies: string[] = [];
  const stack: { open: string; start: number }[] = [];
  for (let index = 0; index < operatorScan.length; index += 1) {
    const char = operatorScan[index];
    if (char === '{' || char === '(') {
      stack.push({ open: char, start: index });
      continue;
    }
    if (char === '}' || char === ')') {
      const expectedOpen = char === '}' ? '{' : '(';
      const top = stack[stack.length - 1];
      if (top && top.open === expectedOpen) {
        stack.pop();
        bodies.push(operatorScan.slice(top.start + 1, index));
      }
    }
  }
  return bodies;
}

/** Splits a body at `;` and `|` outside nested groups; nested bodies are validated on their own. */
function splitBodyStatements(body: string): string[] {
  const statements: string[] = [];
  let current = '';
  let depth = 0;
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char === '{' || char === '(') depth += 1;
    if (char === '}' || char === ')') depth = Math.max(0, depth - 1);
    if ((char === ';' || char === '|') && depth === 0) {
      statements.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  statements.push(current);
  return statements;
}

/** Leading characters that open a PowerShell expression rather than a command invocation. */
const EXPRESSION_TOKEN_PATTERN = /^[$'"@({[\d,+!-]/u;

/**
 * First statement-position token in `body` that could invoke a command and is not allow-listed.
 * Expression starters pass (they cannot invoke without `$(`/`::`/`&`, all blocked elsewhere);
 * `name = value` hashtable entries and assignments pass; bare words must be read-only cmdlets.
 */
function findBlockedBodyToken(body: string): string | null {
  for (const statement of splitBodyStatements(body)) {
    const token = getFirstCommandToken(statement);
    if (!token) continue;
    if (EXPRESSION_TOKEN_PATTERN.test(token)) continue;
    const rest = statement.trimStart().slice(token.length).trimStart();
    if (rest.startsWith('=') && !rest.startsWith('==')) continue;
    if (READ_ONLY_PIPE_COMMANDS.has(token)) continue;
    return token;
  }
  return null;
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

  // Chaining and redirection are inert inside quotes of either kind.
  const operatorScan = blankQuotedSpans(trimmed, { single: true, double: true });
  if (hasBlockedOperator(operatorScan)) {
    return { safe: false, reason: 'shell chaining/redirection is not allowed' };
  }
  if (hasFileRedirection(operatorScan)) {
    return { safe: false, reason: 'file redirection is not allowed' };
  }
  if (operatorScan.includes('::')) {
    return { safe: false, reason: 'static member access is not allowed' };
  }

  // Subexpressions and escapes still fire inside double quotes; only single quotes neutralize them.
  const expansionScan = blankQuotedSpans(trimmed, { single: true, double: false });
  if (hasShellExpansion(expansionScan)) {
    return { safe: false, reason: 'command substitution and escape characters are not allowed' };
  }

  for (const body of extractBracketBodies(operatorScan)) {
    const blockedToken = findBlockedBodyToken(body);
    if (blockedToken !== null) {
      return { safe: false, reason: `command '${blockedToken}' inside a script block or subexpression is not in the allow-list` };
    }
  }

  const segments = splitTopLevelPipes(trimmed);
  const producerToken = getFirstCommandToken(segments[0] || '');
  if (producerToken !== PRODUCER_COMMAND) {
    return { safe: false, reason: `command '${producerToken || '<empty>'}' is not in the allow-list` };
  }
  const subcommand = findGitSubcommand(tokenizeSegment(segments[0] || ''));
  if (subcommand !== null && !READ_ONLY_GIT_SUBCOMMANDS.has(subcommand)) {
    return { safe: false, reason: `git subcommand '${subcommand}' is not read-only` };
  }

  for (const segment of segments.slice(1)) {
    const pipeToken = getFirstCommandToken(segment);
    if (!READ_ONLY_PIPE_COMMANDS.has(pipeToken)) {
      return { safe: false, reason: `command '${pipeToken || '<empty>'}' is not in the allow-list` };
    }
  }

  return { safe: true, reason: null };
}
