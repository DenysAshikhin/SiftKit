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
// ---------------------------------------------------------------------------

export type SafetyResult = {
  safe: boolean;
  reason: string | null;
};

function hasBlockedOperator(command: string): boolean {
  return /&&|\|\||[;`]/u.test(command);
}

function hasFileRedirection(command: string): boolean {
  return /[<>]/u.test(command);
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

function getFirstToken(segment: string): string {
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

function evaluateSegmentSafety(
  segment: string,
  allowedCommands: Set<string>,
): SafetyResult {
  const commandToken = getFirstToken(segment);
  if (!commandToken) {
    return { safe: false, reason: 'empty command segment' };
  }
  if (!allowedCommands.has(commandToken)) {
    return { safe: false, reason: `command '${commandToken}' is not in the allow-list` };
  }
  return { safe: true, reason: null };
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

  if (/\b(rm|del|mv|cp|move-item|copy-item|remove-item|set-content|add-content|out-file|export-[a-z0-9_-]+|tee-object|curl|wget|invoke-webrequest|invoke-restmethod|start-process)\b/iu.test(trimmed)) {
    return { safe: false, reason: 'destructive, file-writing, or network command is not allowed' };
  }

  const segments = splitTopLevelPipes(trimmed);

  const producerCommands = new Set([
    'rg', 'get-content', 'get-childitem', 'select-string', 'git', 'pwd', 'ls',
  ]);
  const pipeCommands = new Set([
    'select-object', 'select-string', 'where-object', 'sort-object',
    'group-object', 'measure-object', 'foreach-object', 'format-table',
    'format-list', 'out-string', 'convertto-json', 'convertfrom-json',
    'get-unique', 'join-string',
  ]);
  const allAllowedCommands = new Set([...producerCommands, ...pipeCommands]);

  if (segments.length === 1) {
    return evaluateSegmentSafety(segments[0], allAllowedCommands);
  }

  for (const segment of segments) {
    const result = evaluateSegmentSafety(segment, allAllowedCommands);
    if (!result.safe) {
      return result;
    }
    if (
      /\bforeach-object\b/iu.test(segment)
      && /\b(set-content|add-content|out-file|export-[a-z0-9_-]+|tee-object|remove-item|move-item|copy-item|rename-item|invoke-webrequest|invoke-restmethod|start-process)\b/iu.test(segment)
    ) {
      return { safe: false, reason: 'ForEach-Object must be read-only' };
    }
  }

  return { safe: true, reason: null };
}

// ---------------------------------------------------------------------------
// Command normalization — rg glob injection, type rewrites, ignore policy
// ---------------------------------------------------------------------------

export type NormalizedCommand = {
  command: string;
  rewritten: boolean;
  note: string;
  rejected?: boolean;
  rejectedReason?: string;
};

function extractRgPattern(commandStr: string): string | null {
  const tokens = tokenizeSegment(commandStr);
  if (!tokens.length || tokens[0].toLowerCase() !== 'rg') {
    return null;
  }

  const rgValueOptions = new Set([
    '-e', '--regexp', '-f', '--file', '-g', '--glob', '--iglob',
    '-t', '--type', '--type-not', '--type-add', '--type-clear',
    '-m', '--max-count', '-A', '-B', '-C', '--context',
    '--max-filesize', '--engine', '--encoding', '--sort', '--sortr', '--threads',
  ]);
  const rgPatternOptions = new Set(['-e', '--regexp']);

  let patternByOption = false;
  let index = 1;

  while (index < tokens.length) {
    const token = tokens[index];
    if (token === '--') {
      index += 1;
      break;
    }
    if (token.startsWith('-')) {
      const normalized = token.toLowerCase();
      if (rgValueOptions.has(normalized)) {
        if (rgPatternOptions.has(normalized)) {
          patternByOption = true;
        }
        index += 2;
        continue;
      }
      index += 1;
      continue;
    }
    if (!patternByOption) {
      return token;
    }
    index += 1;
  }

  if (index < tokens.length && !patternByOption) {
    return tokens[index];
  }

  return null;
}

function looksLikeWindowsPathLiteral(pattern: string): boolean {
  return /[a-zA-Z]:\\/u.test(pattern);
}

function rewriteRgWithFixedStrings(commandStr: string, pattern: string): string | null {
  const hasFixedFlag = /(?:^|\s)(?:-F|--fixed-strings)(?:\s|$)/u.test(commandStr);
  if (hasFixedFlag) {
    return null;
  }

  const alternatives = pattern.split('|').filter(Boolean);
  if (alternatives.length <= 1) {
    const escapedPattern = pattern.replace(/"/gu, '\\"');
    return commandStr.replace(`"${pattern}"`, `"${escapedPattern}"`).replace(/^(rg\s)/iu, '$1-F ');
  }

  const quotedAlternatives = alternatives
    .map((alt) => `-e "${alt.replace(/"/gu, '\\"')}"`)
    .join(' ');
  const withoutPattern = commandStr
    .replace(new RegExp(`(["'])${pattern.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\1`), '')
    .replace(/^(rg)\s+/iu, `$1 -F ${quotedAlternatives} `)
    .replace(/\s{2,}/gu, ' ')
    .trim();
  return withoutPattern;
}

function hasIgnoreDisablingRgFlag(command: string): boolean {
  return /(?:^|\s)(?:-u|-uu|-uuu)(?:\s|$)|(?:^|\s)--no-ignore(?:-[a-z]+)*(?:\s|$)/iu.test(command);
}

function rgAlreadyHasIgnoreGlob(command: string, ignoreName: string): boolean {
  const escaped = ignoreName.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`(?:^|\\s)(?:-g|--glob)\\s+["'][^"']*${escaped}[^"']*["']`, 'iu').test(command);
}

function appendToFirstSegment(command: string, addition: string): string {
  const segments = splitTopLevelPipes(command);
  if (!segments.length) {
    return command;
  }
  segments[0] = `${segments[0]} ${addition}`.trim();
  return segments.join(' | ');
}

type PathExtractionConfig = {
  positionalStart: number;
  skipFlags: Set<string>;
};

function extractPathsForCommandSegment(segment: string, commandName: string): string[] {
  const configByCommand: Record<string, PathExtractionConfig> = {
    'get-content': { positionalStart: 1, skipFlags: new Set(['-encoding', '-raw', '-totalcount', '-readcount', '-delimiter', '-wait']) },
    'get-childitem': { positionalStart: 1, skipFlags: new Set(['-filter', '-include', '-exclude', '-name', '-recurse', '-depth', '-force', '-directory', '-file']) },
  };

  const config = configByCommand[commandName];
  if (!config) {
    return [];
  }

  const tokens = tokenizeSegment(segment);
  const paths: string[] = [];

  for (let i = config.positionalStart; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.startsWith('-')) {
      if (config.skipFlags.has(token.toLowerCase())) {
        i += 1;
      }
      continue;
    }
    paths.push(token);
  }

  return paths;
}

function normalizePathCandidate(value: string): string {
  return String(value || '').replace(/^["']+|["']+$/gu, '').trim();
}

function normalizePathForComparison(value: string): string {
  return String(value || '').replace(/\//gu, '\\').toLowerCase();
}

function pathIsIgnoredByPolicy(
  pathCandidate: string,
  ignorePolicy: IgnorePolicy,
  repoRoot?: string,
): boolean {
  const normalizedRepoRoot = repoRoot
    ? normalizePathForComparison(repoRoot).replace(/\\+$/u, '') + '\\'
    : '';

  let normalizedPath = normalizePathCandidate(pathCandidate).replace(/\//gu, '\\');
  if (!normalizedPath) {
    return false;
  }

  if (normalizedRepoRoot && /^[a-zA-Z]:\\/u.test(normalizedPath)) {
    const candidateLower = normalizePathForComparison(normalizedPath);
    if (candidateLower.startsWith(normalizedRepoRoot)) {
      normalizedPath = normalizedPath.slice(normalizedRepoRoot.length).replace(/^\\+/u, '');
    }
  }

  const segments = normalizedPath.split(/[\\/]+/u).filter(Boolean);
  for (const segment of segments) {
    if (/[*?\[\]]/u.test(segment)) {
      continue;
    }
    if (ignorePolicy.namesLower.has(segment.toLowerCase())) {
      return true;
    }
  }

  return false;
}

export function normalizePlannerCommand(
  command: string,
  options: { repoRoot?: string; ignorePolicy?: IgnorePolicy } = {},
): NormalizedCommand {
  const trimmed = String(command || '').trim();
  if (!trimmed) {
    return { command: trimmed, rewritten: false, note: '' };
  }

  const ignorePolicy = options.ignorePolicy || buildIgnorePolicy(options.repoRoot || '');
  const commandToken = getFirstToken(trimmed);
  let current = trimmed;
  let wasRewritten = false;
  const notes: string[] = [];

  if (commandToken === 'rg') {
    if (hasIgnoreDisablingRgFlag(current)) {
      return {
        command: current,
        rewritten: false,
        note: '',
        rejected: true,
        rejectedReason: 'ignore-disabling rg flags are not allowed',
      };
    }

    // Rewrite unsupported --type tsx/jsx to ts/js
    const unsupportedTypeMap: Record<string, string> = { tsx: 'ts', jsx: 'js' };
    const typeMatches = [...current.matchAll(/(?:^|\s)--type\s+(\S+)/giu)];
    const unsupportedTypes = typeMatches
      .map((m) => m[1].toLowerCase())
      .filter((t) => t in unsupportedTypeMap);

    if (unsupportedTypes.length > 0) {
      const allTypes = typeMatches.map((m) => m[1].toLowerCase());
      const finalTypes = new Set<string>();
      for (const t of allTypes) {
        finalTypes.add(unsupportedTypeMap[t] || t);
      }
      current = current.replace(/\s--type\s+\S+/giu, '');
      for (const t of finalTypes) {
        current = `${current} --type ${t}`;
      }
      current = current.trim();
      wasRewritten = true;
      notes.push(`rewrote unsupported --type ${unsupportedTypes.join(', ')} to valid types`);
    }

    // Rewrite Windows path-literal patterns to use -F
    const rgPattern = extractRgPattern(current);
    if (rgPattern && looksLikeWindowsPathLiteral(rgPattern)) {
      const rewritten = rewriteRgWithFixedStrings(current, rgPattern);
      if (rewritten) {
        current = rewritten;
        wasRewritten = true;
        notes.push('added -F for Windows path literal pattern');
      }
    }

    // Bypass rg's own .gitignore/.ignore handling — we control exclusions via explicit globs
    if (!/(?:^|\s)--no-ignore(?:\s|$)/iu.test(current)) {
      current = `${current} --no-ignore`;
      notes.push('added --no-ignore so rg searches gitignored paths');
      wasRewritten = true;
    }

    // Append ignore policy globs
    if (Array.isArray(ignorePolicy.names) && ignorePolicy.names.length > 0) {
      const missingNames = ignorePolicy.names.filter(
        (name) => !rgAlreadyHasIgnoreGlob(current, name),
      );
      if (missingNames.length > 0) {
        const globArgs = missingNames
          .map((name) => `--glob "!**/${name.replace(/"/gu, '\\"')}/**"`)
          .join(' ');
        current = `${current} ${globArgs}`.trim();
        notes.push('added ignore globs from ignore policy');
        wasRewritten = true;
      }
    }
    if (Array.isArray(ignorePolicy.paths) && ignorePolicy.paths.length > 0) {
      const pathGlobArgs = ignorePolicy.paths
        .map((p) => `--glob "!${p.replace(/"/gu, '\\"')}/**"`)
        .join(' ');
      current = `${current} ${pathGlobArgs}`.trim();
      notes.push('added path ignore globs from ignore policy');
      wasRewritten = true;
    }
  } else if (commandToken === 'get-childitem' || commandToken === 'ls') {
    if (
      Array.isArray(ignorePolicy.names)
      && ignorePolicy.names.length > 0
      && !/(?:^|\s)-exclude(?:\s|$)/iu.test(current)
    ) {
      current = appendToFirstSegment(current, `-Exclude ${ignorePolicy.names.join(',')}`);
      notes.push('added -Exclude from ignore policy');
      wasRewritten = true;
    }
  } else if (commandToken === 'select-string') {
    const hasPathOption = /(?:^|\s)-(?:path|literalpath)(?:\s|$)/iu.test(current);
    if (
      hasPathOption
      && Array.isArray(ignorePolicy.names)
      && ignorePolicy.names.length > 0
      && !/(?:^|\s)-exclude(?:\s|$)/iu.test(current)
    ) {
      current = appendToFirstSegment(current, `-Exclude ${ignorePolicy.names.join(',')}`);
      notes.push('added -Exclude from ignore policy');
      wasRewritten = true;
    }
  } else if (commandToken === 'get-content') {
    const pipeSegments = splitTopLevelPipes(current);
    for (const seg of pipeSegments) {
      if (getFirstToken(seg) !== 'get-content') {
        continue;
      }
      const pathCandidates = extractPathsForCommandSegment(seg, 'get-content');
      if (pathCandidates.some((candidate) => pathIsIgnoredByPolicy(candidate, ignorePolicy, options.repoRoot))) {
        return {
          command: current,
          rewritten: false,
          note: '',
          rejected: true,
          rejectedReason: 'command targets a path ignored by policy',
        };
      }
    }
  }

  if (!wasRewritten) {
    return { command: current, rewritten: false, note: '' };
  }

  return {
    command: current,
    rewritten: true,
    note: `note: ${notes.join('; ')}; ran '${current}' instead`,
  };
}

// ---------------------------------------------------------------------------
// Misc helpers used by the engine
// ---------------------------------------------------------------------------

export function isSearchNoMatchExit(command: string, exitCode: number): boolean {
  if (exitCode !== 1) return false;
  const trimmed = command.trimStart();
  return /^(rg|grep|egrep|fgrep|diff|find)\b/u.test(trimmed);
}
