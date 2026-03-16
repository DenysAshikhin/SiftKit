"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.importMarkdownBenchmark = importMarkdownBenchmark;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const node_child_process_1 = require("node:child_process");
const config_js_1 = require("./config.js");
function parseArguments(argv) {
    const parsed = {};
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
    return parsed;
}
function parseSuite(text) {
    const repoMatch = text.match(/Run from repo root:\s*`([^`]+)`/u);
    const repoRoot = repoMatch ? repoMatch[1] : null;
    const casePattern = /^##\s+(\d{2})\.\s+(.+?)\r?\nCommand:\r?\n```powershell\r?\n([\s\S]*?)\r?\n```\r?\nQuery:\r?\n`([\s\S]*?)`\r?\nAnswer key:\r?\n([\s\S]*?)(?=^\s*##\s+\d{2}\.|$)/gmu;
    const cases = [];
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
function stripSiftkitPipe(command) {
    return command.replace(/\s*\|\s*siftkit\s+"[\s\S]*?"\s*$/u, '').trim();
}
function slugify(value) {
    return value
        .toLowerCase()
        .replace(/[^a-z0-9]+/gu, '_')
        .replace(/^_+|_+$/gu, '')
        .slice(0, 80);
}
function runPowerShell(command, cwd) {
    const result = (0, node_child_process_1.spawnSync)('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], {
        cwd,
        encoding: 'utf8',
        windowsHide: true,
    });
    const stdout = result.stdout || '';
    const stderr = result.stderr || '';
    const combined = `${stdout}${stdout && stderr ? '\n' : ''}${stderr}`.trimEnd();
    if (result.error) {
        throw result.error;
    }
    return combined;
}
function importMarkdownBenchmark(options) {
    const suiteFile = path.resolve(options.suiteFile);
    const outputDir = path.resolve(options.outputDir);
    const markdown = fs.readFileSync(suiteFile, 'utf8');
    const parsed = parseSuite(markdown);
    const repoRoot = path.resolve(options.repoRoot || parsed.repoRoot || process.cwd());
    const rawDir = path.join(outputDir, 'raw');
    const fixtures = [];
    fs.mkdirSync(rawDir, { recursive: true });
    for (const entry of parsed.cases) {
        const sourceCommand = stripSiftkitPipe(entry.Command);
        const fileName = `${entry.Index}_${slugify(entry.Name) || 'case'}.txt`;
        const rawOutput = runPowerShell(sourceCommand, repoRoot);
        (0, config_js_1.saveContentAtomically)(path.join(rawDir, fileName), rawOutput);
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
    (0, config_js_1.saveContentAtomically)(path.join(outputDir, 'fixtures.json'), `${JSON.stringify(fixtures, null, 2)}\n`);
    (0, config_js_1.saveContentAtomically)(path.join(outputDir, 'README.md'), [
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
function main() {
    const result = importMarkdownBenchmark(parseArguments(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
if (require.main === module) {
    try {
        main();
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`${message}\n`);
        process.exit(1);
    }
}
