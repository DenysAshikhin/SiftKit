#!/usr/bin/env node
import path from 'node:path';

type SafetyResult = {
  safe: boolean;
  reason: string | null;
};

type CommandSafetyModule = {
  evaluateCommandSafety(command: string, repoRoot?: string): SafetyResult;
  parseDirectRgCommand(command: string): unknown | null;
};

type ReproSegment = {
  index: number;
  text: string;
  commandToken: string;
};

type ReproReport = {
  fixture: string;
  command: string;
  segments: ReproSegment[];
  directRgSegments: ReproSegment[];
  safety: SafetyResult;
  directRgParsed: boolean;
  reproduced: boolean;
  legacyFromSplit: boolean;
  parserMismatch: boolean;
  pipeEvents: Array<{ index: number; inSingle: boolean; inDouble: boolean; split: boolean }>;
};

const DEFAULT_COMMAND = 'rg -n "from " apps/runner/src | from "internal"';
const AUDIT_COMMAND_4 = 'rg -n "from [\'\\"].*\\.internal --no-ignore --ignore-case --glob "!**/.git/**" | from [\'\\"].*\\.internal|import.*\\/internal\\/" --glob "*.test.ts" apps/runner/src/__tests__';

const FIXTURES: Record<string, string> = {
  default: DEFAULT_COMMAND,
  'audit-command-4': AUDIT_COMMAND_4,
  'likely-intended': 'rg -n "from [\'\\"].*\\.internal|import.*\\/internal\\/" --glob "*.test.ts" apps/runner/src/__tests__',
};

function loadCommandSafety(): CommandSafetyModule {
  const runningFromDist = path.basename(__dirname).toLowerCase() === 'scripts'
    && path.basename(path.dirname(__dirname)).toLowerCase() === 'dist';
  const base = runningFromDist
    ? path.resolve(__dirname, '..')
    : path.resolve(__dirname, '..', 'src');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(path.join(base, 'repo-search', 'command-safety.js')) as CommandSafetyModule;
}

function splitTopLevelPipesForReport(
  command: string,
  options: { backslashEscapesQuotes: boolean },
): { segments: string[]; pipeEvents: Array<{ index: number; inSingle: boolean; inDouble: boolean; split: boolean }> } {
  const segments: string[] = [];
  const pipeEvents: Array<{ index: number; inSingle: boolean; inDouble: boolean; split: boolean }> = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (
      options.backslashEscapesQuotes
      && char === '\\'
      && index + 1 < command.length
      && ((inDouble && command[index + 1] === '"') || (inSingle && command[index + 1] === "'"))
    ) {
      current += char + command[index + 1];
      index += 1;
      continue;
    }
    if (char === '\'' && !inDouble) {
      inSingle = !inSingle;
    } else if (char === '"' && !inSingle) {
      inDouble = !inDouble;
    }
    if (char === '|') {
      pipeEvents.push({ index, inSingle, inDouble, split: !inSingle && !inDouble });
    }
    if (char === '|' && !inSingle && !inDouble) {
      segments.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  segments.push(current.trim());
  return { segments: segments.filter(Boolean), pipeEvents };
}

function getCommandToken(segment: string): string {
  return String(segment.trim().split(/\s+/u)[0] || '').toLowerCase();
}

function toReproSegments(segments: string[]): ReproSegment[] {
  return segments.map((text, index) => ({
    index,
    text,
    commandToken: getCommandToken(text),
  }));
}

export function buildPipeFromReproReport(
  command: string = DEFAULT_COMMAND,
  fixture = 'custom',
): ReproReport {
  const commandSafety = loadCommandSafety();
  const safety = commandSafety.evaluateCommandSafety(command, process.cwd());
  const legacySplit = splitTopLevelPipesForReport(command, { backslashEscapesQuotes: false });
  const directSplit = splitTopLevelPipesForReport(command, { backslashEscapesQuotes: true });
  const segments = toReproSegments(legacySplit.segments);
  const directRgSegments = toReproSegments(directSplit.segments);
  const legacyFromSplit = segments.some((segment) => segment.commandToken === 'from');
  return {
    fixture,
    command,
    segments,
    directRgSegments,
    safety,
    directRgParsed: commandSafety.parseDirectRgCommand(command) !== null,
    reproduced: safety.safe === false && safety.reason === "command 'from' is not in the allow-list",
    legacyFromSplit,
    parserMismatch: segments.length !== directRgSegments.length,
    pipeEvents: legacySplit.pipeEvents,
  };
}

function parseArgs(argv: string[]): { command: string; fixture: string; json: boolean } {
  let command = DEFAULT_COMMAND;
  let fixture = 'default';
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg === '--command') {
      command = String(argv[++index] || '');
      fixture = 'custom';
      continue;
    }
    if (arg === '--fixture') {
      fixture = String(argv[++index] || '');
      command = FIXTURES[fixture] || '';
      if (!command) {
        throw new Error(`Unknown fixture: ${fixture}`);
      }
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return { command, fixture, json };
}

function printHumanReport(report: ReproReport): void {
  process.stdout.write(`fixture: ${report.fixture}\n`);
  process.stdout.write(`command: ${report.command}\n`);
  process.stdout.write('legacy segments:\n');
  for (const segment of report.segments) {
    process.stdout.write(`  ${segment.index}: token=${segment.commandToken} text=${segment.text}\n`);
  }
  process.stdout.write('direct rg segments:\n');
  for (const segment of report.directRgSegments) {
    process.stdout.write(`  ${segment.index}: token=${segment.commandToken} text=${segment.text}\n`);
  }
  process.stdout.write(`directRgParsed: ${String(report.directRgParsed)}\n`);
  process.stdout.write(`safe: ${String(report.safety.safe)}\n`);
  process.stdout.write(`reason: ${report.safety.reason || ''}\n`);
  process.stdout.write(`legacyFromSplit: ${String(report.legacyFromSplit)}\n`);
  process.stdout.write(`parserMismatch: ${String(report.parserMismatch)}\n`);
  process.stdout.write(`reproduced: ${String(report.reproduced)}\n`);
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  const report = buildPipeFromReproReport(args.command, args.fixture);
  if (args.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    printHumanReport(report);
  }
}
