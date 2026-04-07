import * as fs from 'node:fs';
import * as path from 'node:path';
import { saveContentAtomically } from './lib/fs.js';
import { spawnPowerShellSync } from './lib/powershell.js';

type ImportedFixture = {
  Name: string;
  File: string;
  Question: string;
  Format: 'text';
  PolicyProfile: 'general';
  SourceCommand: string;
  AnswerKey: string;
};

type ParsedCase = {
  Index: string;
  Name: string;
  Command: string;
  Question: string;
  AnswerKey: string;
};

type ImportOptions = {
  suiteFile: string;
  outputDir: string;
  repoRoot?: string;
};

function parseArguments(argv: string[]): ImportOptions {
  const parsed: Partial<ImportOptions> = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    switch (token) {
      case '--suite-file':
        parsed.suiteFile = argv[++index];
        break;
      case '--output-dir':
        parsed.outputDir = argv[++index];
        break;
      case '--repo-root':
        parsed.repoRoot = argv[++index];
        break;
      default:
        throw new Error(`Unknown argument: ${token}`);
    }
  }

  if (!parsed.suiteFile) {
    throw new Error('A --suite-file is required.');
  }
  if (!parsed.outputDir) {
    throw new Error('An --output-dir is required.');
  }

  return parsed as ImportOptions;
}

function parseSuite(text: string): { repoRoot: string | null; cases: ParsedCase[] } {
  const repoMatch = text.match(/Run from repo root:\s*`([^`]+)`/u);
  const repoRoot = repoMatch ? repoMatch[1] : null;
  const casePattern = /^##\s+(\d{2})\.\s+(.+?)\r?\nCommand:\r?\n```powershell\r?\n([\s\S]*?)\r?\n```\r?\nQuery:\r?\n`([\s\S]*?)`\r?\nAnswer key:\r?\n([\s\S]*?)(?=^\s*##\s+\d{2}\.|$)/gmu;
  const cases: ParsedCase[] = [];

  for (const match of text.matchAll(casePattern)) {
    cases.push({
      Index: match[1],
      Name: match[2].trim(),
      Command: match[3].trim(),
      Question: match[4].trim(),
      AnswerKey: match[5].trim(),
    });
  }

  if (cases.length === 0) {
    throw new Error('No benchmark cases were parsed from the markdown suite.');
  }

  return { repoRoot, cases };
}

function stripSiftkitPipe(command: string): string {
  return command.replace(/\s*\|\s*siftkit\s+"[\s\S]*?"\s*$/u, '').trim();
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '_')
    .replace(/^_+|_+$/gu, '')
    .slice(0, 80);
}

function runPowerShell(command: string, cwd: string): string {
  const result = spawnPowerShellSync(command, { cwd });

  const stdout = result.stdout || '';
  const stderr = result.stderr || '';
  const combined = `${stdout}${stdout && stderr ? '\n' : ''}${stderr}`.trimEnd();

  if (result.error) {
    throw result.error;
  }

  return combined;
}

export function importMarkdownBenchmark(options: ImportOptions): {
  SuiteFile: string;
  RepoRoot: string;
  OutputDir: string;
  FixtureCount: number;
} {
  const suiteFile = path.resolve(options.suiteFile);
  const outputDir = path.resolve(options.outputDir);
  const markdown = fs.readFileSync(suiteFile, 'utf8');
  const parsed = parseSuite(markdown);
  const repoRoot = path.resolve(options.repoRoot || parsed.repoRoot || process.cwd());
  const rawDir = path.join(outputDir, 'raw');
  const fixtures: ImportedFixture[] = [];

  fs.mkdirSync(rawDir, { recursive: true });

  for (const entry of parsed.cases) {
    const sourceCommand = stripSiftkitPipe(entry.Command);
    const fileName = `${entry.Index}_${slugify(entry.Name) || 'case'}.txt`;
    const rawOutput = runPowerShell(sourceCommand, repoRoot);
    saveContentAtomically(path.join(rawDir, fileName), rawOutput);

    fixtures.push({
      Name: `${entry.Index}. ${entry.Name}`,
      File: path.join('raw', fileName).replace(/\\/gu, '/'),
      Question: entry.Question,
      Format: 'text',
      PolicyProfile: 'general',
      SourceCommand: sourceCommand,
      AnswerKey: entry.AnswerKey,
    });
  }

  saveContentAtomically(path.join(outputDir, 'fixtures.json'), `${JSON.stringify(fixtures, null, 2)}\n`);
  saveContentAtomically(path.join(outputDir, 'README.md'), [
    '# Imported Benchmark Fixtures',
    '',
    `Source suite: ${suiteFile}`,
    `Repo root: ${repoRoot}`,
    '',
    'This folder was generated from the markdown benchmark suite.',
    'Each raw fixture file contains the command output before SiftKit summarization.',
    'Use it with `npm run benchmark -- --fixture-root "<this-folder>"`.',
    '',
    `Fixture count: ${fixtures.length}`,
  ].join('\n'));

  return {
    SuiteFile: suiteFile,
    RepoRoot: repoRoot,
    OutputDir: outputDir,
    FixtureCount: fixtures.length,
  };
}

function main(): void {
  const result = importMarkdownBenchmark(parseArguments(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  }
}
