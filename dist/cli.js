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
exports.runCli = runCli;
const fs = __importStar(require("node:fs"));
const http = __importStar(require("node:http"));
const https = __importStar(require("node:https"));
const node_util_1 = require("node:util");
const config_js_1 = require("./config.js");
const find_files_js_1 = require("./find-files.js");
const llama_cpp_js_1 = require("./providers/llama-cpp.js");
const summary_js_1 = require("./summary.js");
const command_js_1 = require("./command.js");
const eval_js_1 = require("./eval.js");
const install_js_1 = require("./install.js");
const interactive_js_1 = require("./interactive.js");
const repo_search_js_1 = require("./repo-search.js");
const KNOWN_COMMANDS = new Set([
    'summary',
    'repo-search',
    'internal',
]);
const BLOCKED_PUBLIC_COMMANDS = new Set([
    'run',
    'find-files',
    'install',
    'test',
    'eval',
    'codex-policy',
    'install-global',
    'config-get',
    'config-set',
    'capture-internal',
]);
function showHelp(stdout) {
    stdout.write([
        'SiftKit CLI',
        '',
        'Usage:',
        '  siftkit "question"',
        '  siftkit summary --question "..." [--text "..."] [--file path]',
        '  siftkit repo-search --prompt "find x y z in this repo"',
        '  siftkit -prompt "find x y z in this repo"',
        '',
    ].join('\n'));
}
const SERVER_DEPENDENT_COMMANDS = new Set([
    'summary',
    'run',
    'install',
    'test',
    'eval',
    'config-get',
    'config-set',
    'capture-internal',
    'repo-search',
]);
const SERVER_DEPENDENT_INTERNAL_OPS = new Set([
    'install',
    'test',
    'config-get',
    'config-set',
    'summary',
    'command',
    'command-analyze',
    'eval',
    'interactive-capture',
    'repo-search',
]);
function getCommandName(argv) {
    if (argv.length > 0 && KNOWN_COMMANDS.has(argv[0])) {
        return argv[0];
    }
    if (argv[0] === '--prompt' || argv[0] === '-prompt') {
        return 'repo-search';
    }
    return 'summary';
}
function getCommandArgs(argv) {
    const commandName = getCommandName(argv);
    if (commandName === 'repo-search' && (argv[0] === '--prompt' || argv[0] === '-prompt')) {
        return argv;
    }
    if (commandName === 'summary' && (argv.length === 0 || !KNOWN_COMMANDS.has(argv[0]))) {
        return argv;
    }
    return argv.slice(1);
}
function parseArguments(tokens) {
    const parsed = {
        positionals: [],
    };
    for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index];
        switch (token) {
            case '--question':
                parsed.question = tokens[++index];
                break;
            case '--text':
                parsed.text = tokens[++index];
                break;
            case '--file':
                parsed.file = tokens[++index];
                break;
            case '--backend':
                parsed.backend = tokens[++index];
                break;
            case '--model':
                parsed.model = tokens[++index];
                break;
            case '--profile':
                parsed.profile = tokens[++index];
                break;
            case '--format':
                parsed.format = tokens[++index];
                break;
            case '--path':
                parsed.path = tokens[++index];
                break;
            case '--full-path':
                parsed.fullPath = true;
                break;
            case '--key':
                parsed.key = tokens[++index];
                break;
            case '--value':
                parsed.value = tokens[++index];
                break;
            case '--command':
                parsed.command = tokens[++index];
                break;
            case '--arg':
                parsed.argList ??= [];
                parsed.argList.push(tokens[++index]);
                break;
            case '--risk':
                parsed.risk = tokens[++index];
                break;
            case '--reducer':
                parsed.reducer = tokens[++index];
                break;
            case '--fixture-root':
                parsed.fixtureRoot = tokens[++index];
                break;
            case '--codex-home':
                parsed.codexHome = tokens[++index];
                break;
            case '--bin-dir':
                parsed.binDir = tokens[++index];
                break;
            case '--module-root':
                parsed.moduleRoot = tokens[++index];
                break;
            case '--startup-dir':
                parsed.startupDir = tokens[++index];
                break;
            case '--status-path':
                parsed.statusPath = tokens[++index];
                break;
            case '--request-file':
                parsed.requestFile = tokens[++index];
                break;
            case '--response-format':
                parsed.responseFormat = tokens[++index];
                break;
            case '--op':
                parsed.op = tokens[++index];
                break;
            case '--prompt':
            case '-prompt':
                parsed.prompt = tokens[++index];
                break;
            case '--max-turns':
                parsed.maxTurns = Number(tokens[++index]);
                break;
            case '--log-file':
                parsed.logFile = tokens[++index];
                break;
            default:
                parsed.positionals.push(token);
                break;
        }
    }
    return parsed;
}
function formatPsList(value) {
    const record = value;
    const entries = Object.entries(record);
    return `${entries.map(([key, item]) => {
        const rendered = Array.isArray(item) ? item.join(', ') : (0, node_util_1.inspect)(item, { depth: 6, breakLength: Infinity });
        return `${key} : ${rendered}`;
    }).join('\n')}\n`;
}
function getRepoSearchServiceUrl() {
    const target = new URL((0, config_js_1.getStatusBackendUrl)());
    target.pathname = '/repo-search';
    target.search = '';
    target.hash = '';
    return target.toString();
}
function requestJson(options) {
    return new Promise((resolve, reject) => {
        const target = new URL(options.url);
        const transport = target.protocol === 'https:' ? https : http;
        const request = transport.request({
            protocol: target.protocol,
            hostname: target.hostname,
            port: target.port || (target.protocol === 'https:' ? 443 : 80),
            path: `${target.pathname}${target.search}`,
            method: options.method,
            headers: options.body ? {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(options.body, 'utf8'),
            } : undefined,
        }, (response) => {
            let responseText = '';
            response.setEncoding('utf8');
            response.on('data', (chunk) => {
                responseText += chunk;
            });
            response.on('end', () => {
                if ((response.statusCode || 0) >= 400) {
                    reject(new Error(`HTTP ${response.statusCode}: ${responseText}`));
                    return;
                }
                if (!responseText.trim()) {
                    resolve({});
                    return;
                }
                try {
                    resolve(JSON.parse(responseText));
                }
                catch (error) {
                    reject(error);
                }
            });
        });
        request.setTimeout(options.timeoutMs, () => {
            request.destroy(new Error(`Request timed out after ${options.timeoutMs} ms.`));
        });
        request.on('error', reject);
        if (options.body) {
            request.write(options.body);
        }
        request.end();
    });
}
async function runSummary(options) {
    const parsed = parseArguments(getCommandArgs(options.argv));
    const question = parsed.question || parsed.positionals[0];
    if (!question) {
        throw new Error('A question is required.');
    }
    const inputText = (0, summary_js_1.readSummaryInput)({
        text: parsed.text,
        file: parsed.file,
        stdinText: options.stdinText,
    });
    if ((!parsed.file || parsed.file.length === 0) && !inputText?.trim()) {
        throw new Error('stdin, --text or --file required');
    }
    const result = await (0, summary_js_1.summarizeRequest)({
        question,
        inputText: inputText ?? '',
        format: parsed.format === 'json' ? 'json' : 'text',
        policyProfile: parsed.profile || 'general',
        backend: parsed.backend,
        model: parsed.model,
        sourceKind: process.env.SIFTKIT_SUMMARY_SOURCE_KIND === 'command-output' || Boolean(options.stdinText?.trim())
            ? 'command-output'
            : 'standalone',
        commandExitCode: process.env.SIFTKIT_SUMMARY_COMMAND_EXIT_CODE?.trim()
            ? Number.parseInt(process.env.SIFTKIT_SUMMARY_COMMAND_EXIT_CODE, 10)
            : undefined,
    });
    options.stdout.write(`${result.Summary}\n`);
    return 0;
}
async function runInstall(stdout) {
    const result = await (0, install_js_1.installSiftKit)(false);
    stdout.write(formatPsList(result));
    return 0;
}
async function runConfigGet(stdout) {
    const config = await (0, config_js_1.loadConfig)({ ensure: true });
    stdout.write(`${JSON.stringify(config, null, 2)}\n`);
    return 0;
}
async function runConfigSet(options) {
    const parsed = parseArguments(getCommandArgs(options.argv));
    if (!parsed.key) {
        throw new Error('A --key is required.');
    }
    const config = await (0, config_js_1.setTopLevelConfigKey)(parsed.key, parsed.value ?? null);
    options.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
    return 0;
}
async function runFindFiles(options) {
    const parsed = parseArguments(getCommandArgs(options.argv));
    if (parsed.positionals.length === 0) {
        throw new Error('At least one file name or pattern is required.');
    }
    const results = (0, find_files_js_1.findFiles)(parsed.positionals, parsed.path || '.');
    for (const result of results) {
        options.stdout.write(`${parsed.fullPath ? result.FullPath : result.RelativePath}\n`);
    }
    return 0;
}
async function runTest(stdout) {
    const result = await buildTestResult();
    stdout.write(formatPsList(result));
    return 0;
}
async function buildTestResult() {
    const config = await (0, config_js_1.loadConfig)({ ensure: true });
    let model = null;
    let modelError = null;
    try {
        model = (0, config_js_1.getConfiguredModel)(config);
    }
    catch (error) {
        modelError = error instanceof Error ? error.message : String(error);
    }
    const providerStatus = config.Backend === 'llama.cpp'
        ? await (0, llama_cpp_js_1.getLlamaCppProviderStatus)(config)
        : {
            Available: true,
            Reachable: true,
            BaseUrl: 'mock://local',
            Error: null,
        };
    const models = config.Backend === 'llama.cpp' && providerStatus.Reachable ? await (0, llama_cpp_js_1.listLlamaCppModels)(config) : ['mock-model'];
    const modelPresent = model === null || models.length === 0 ? null : models.includes(model);
    const issues = [];
    if (!providerStatus.Available) {
        issues.push('Backend is not available.');
    }
    if (!providerStatus.Reachable) {
        issues.push('llama.cpp server is not reachable.');
    }
    if (modelError) {
        issues.push(modelError);
    }
    if (modelPresent === false && model) {
        issues.push(`Configured model not found: ${model}`);
    }
    return {
        Ready: issues.length === 0,
        ConfigPath: (0, config_js_1.getConfigPath)(),
        RuntimeRoot: config.Paths?.RuntimeRoot,
        LogsPath: config.Paths?.Logs,
        EvalFixturesPath: config.Paths?.EvalFixtures,
        EvalResultsPath: config.Paths?.EvalResults,
        Backend: config.Backend,
        Model: model,
        LlamaCppBaseUrl: providerStatus.BaseUrl,
        LlamaCppReachable: providerStatus.Reachable,
        AvailableModels: models,
        ModelPresent: modelPresent,
        EffectiveNumCtx: config.Effective?.NumCtx ?? null,
        EffectiveInputCharactersPerToken: config.Effective?.InputCharactersPerContextToken ?? null,
        EffectiveBudgetSource: config.Effective?.BudgetSource ?? null,
        EffectiveObservedTelemetrySeen: config.Effective?.ObservedTelemetrySeen ?? null,
        EffectiveObservedTelemetryUpdatedAtUtc: config.Effective?.ObservedTelemetryUpdatedAtUtc ?? null,
        EffectiveMaxInputCharacters: config.Effective?.MaxInputCharacters ?? null,
        EffectiveChunkThresholdCharacters: config.Effective?.ChunkThresholdCharacters ?? null,
        ProviderError: providerStatus.Error,
        Issues: issues,
    };
}
async function runCommandCli(options) {
    const parsed = parseArguments(getCommandArgs(options.argv));
    const command = parsed.command || parsed.positionals[0];
    if (!command) {
        throw new Error('A command is required.');
    }
    const argList = (parsed.argList && parsed.argList.length > 0)
        ? parsed.argList
        : parsed.positionals.slice(1);
    const result = await (0, command_js_1.runCommand)({
        Command: command,
        ArgumentList: argList,
        Question: parsed.question,
        RiskLevel: parsed.risk,
        ReducerProfile: parsed.reducer,
        Format: parsed.format === 'json' ? 'json' : 'text',
        PolicyProfile: parsed.profile || 'general',
        Backend: parsed.backend,
        Model: parsed.model,
    });
    if (result.Summary) {
        options.stdout.write(`${result.Summary}\n`);
    }
    else {
        options.stdout.write('No summary generated.\n');
    }
    options.stdout.write(`Raw log: ${result.RawLogPath}\n`);
    return 0;
}
async function runEvalCli(options) {
    const parsed = parseArguments(getCommandArgs(options.argv));
    const result = await (0, eval_js_1.runEvaluation)({
        FixtureRoot: parsed.fixtureRoot,
        Backend: parsed.backend,
        Model: parsed.model,
    });
    options.stdout.write(formatPsList(result));
    return 0;
}
async function runCodexPolicyCli(options) {
    const parsed = parseArguments(getCommandArgs(options.argv));
    const result = await (0, install_js_1.installCodexPolicy)(parsed.codexHome);
    options.stdout.write(formatPsList(result));
    return 0;
}
async function runInstallGlobalCli(options) {
    const parsed = parseArguments(getCommandArgs(options.argv));
    const result = await (0, install_js_1.installShellIntegration)({
        BinDir: parsed.binDir,
        ModuleInstallRoot: parsed.moduleRoot,
    });
    options.stdout.write(formatPsList(result));
    return 0;
}
async function runCaptureInternalCli(options) {
    const parsed = parseArguments(getCommandArgs(options.argv));
    const command = parsed.command || parsed.positionals[0];
    if (!command) {
        throw new Error('A command is required.');
    }
    const argList = (parsed.argList && parsed.argList.length > 0)
        ? parsed.argList
        : parsed.positionals.slice(1);
    const result = await (0, interactive_js_1.runInteractiveCapture)({
        Command: command,
        ArgumentList: argList,
        Question: parsed.question,
        Format: parsed.format === 'json' ? 'json' : 'text',
        PolicyProfile: parsed.profile || 'general',
        Backend: parsed.backend,
        Model: parsed.model,
    });
    options.stdout.write(`${String(result.OutputText)}\n`);
    return 0;
}
async function runRepoSearchCli(options) {
    const tokens = getCommandArgs(options.argv);
    if (tokens.some((token) => token === '-h' || token === '--h' || token === '--help' || token === '-help')) {
        options.stdout.write('Usage: siftkit repo-search --prompt "find x y z in this repo" [--model <model>] [--max-turns <n>] [--log-file <path>]\n'
            + 'Shortcut: siftkit -prompt "find x y z in this repo"\n');
        return 0;
    }
    const parsed = parseArguments(tokens);
    const prompt = (parsed.prompt || parsed.question || parsed.positionals.join(' ')).trim();
    if (!prompt) {
        throw new Error('A --prompt is required for repo-search.');
    }
    const response = await requestJson({
        url: getRepoSearchServiceUrl(),
        method: 'POST',
        timeoutMs: 10 * 60 * 1000,
        body: JSON.stringify({
            prompt,
            repoRoot: process.cwd(),
            model: parsed.model,
            maxTurns: parsed.maxTurns,
            logFile: parsed.logFile,
        }),
    });
    const scorecard = response.scorecard && typeof response.scorecard === 'object'
        ? response.scorecard
        : null;
    const finalOutputs = Array.isArray(scorecard?.tasks)
        ? scorecard.tasks
            .map((task) => (typeof task?.finalOutput === 'string' ? task.finalOutput.trim() : ''))
            .filter((value) => value.length > 0)
        : [];
    if (finalOutputs.length > 0) {
        options.stdout.write(`${finalOutputs.join('\n\n')}\n`);
        return 0;
    }
    options.stdout.write(`${JSON.stringify(response.scorecard, null, 2)}\n`);
    return 0;
}
function readRequestFile(filePath) {
    const text = fs.readFileSync(filePath, 'utf8');
    const normalized = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
    return JSON.parse(normalized);
}
async function runInternal(options) {
    const parsed = parseArguments(getCommandArgs(options.argv));
    if (!parsed.op) {
        throw new Error('An --op is required.');
    }
    if (!parsed.requestFile) {
        throw new Error('A --request-file is required.');
    }
    if (SERVER_DEPENDENT_INTERNAL_OPS.has(parsed.op)) {
        await (0, config_js_1.ensureStatusServerReachable)();
    }
    const request = readRequestFile(parsed.requestFile);
    let result;
    switch (parsed.op) {
        case 'install':
            result = await (0, install_js_1.installSiftKit)(Boolean(request.Force));
            break;
        case 'test':
            result = await buildTestResult();
            break;
        case 'config-get':
            result = await (0, config_js_1.loadConfig)({ ensure: true });
            break;
        case 'config-set':
            result = await (0, config_js_1.setTopLevelConfigKey)(String(request.Key), request.Value);
            break;
        case 'summary': {
            const text = request.TextFile ? require('node:fs').readFileSync(String(request.TextFile), 'utf8') : String(request.Text || '');
            result = await (0, summary_js_1.summarizeRequest)({
                question: String(request.Question),
                inputText: text,
                format: (request.Format === 'json' ? 'json' : 'text'),
                policyProfile: (request.PolicyProfile || 'general'),
                backend: request.Backend ? String(request.Backend) : undefined,
                model: request.Model ? String(request.Model) : undefined,
            });
            break;
        }
        case 'command':
            result = await (0, command_js_1.runCommand)({
                Command: String(request.Command),
                ArgumentList: Array.isArray(request.ArgumentList) ? request.ArgumentList.map(String) : [],
                Question: request.Question ? String(request.Question) : undefined,
                RiskLevel: request.RiskLevel,
                ReducerProfile: request.ReducerProfile,
                Format: request.Format === 'json' ? 'json' : 'text',
                PolicyProfile: request.PolicyProfile,
                Backend: request.Backend ? String(request.Backend) : undefined,
                Model: request.Model ? String(request.Model) : undefined,
                NoSummarize: Boolean(request.NoSummarize),
            });
            break;
        case 'command-analyze': {
            const text = request.RawTextFile ? fs.readFileSync(String(request.RawTextFile), 'utf8') : String(request.RawText || '');
            result = await (0, command_js_1.analyzeCommandOutput)({
                ExitCode: Number(request.ExitCode || 0),
                CombinedText: text,
                Question: request.Question ? String(request.Question) : undefined,
                RiskLevel: request.RiskLevel,
                ReducerProfile: request.ReducerProfile,
                Format: request.Format === 'json' ? 'json' : 'text',
                PolicyProfile: request.PolicyProfile,
                Backend: request.Backend ? String(request.Backend) : undefined,
                Model: request.Model ? String(request.Model) : undefined,
                NoSummarize: Boolean(request.NoSummarize),
            });
            break;
        }
        case 'eval':
            result = await (0, eval_js_1.runEvaluation)({
                FixtureRoot: request.FixtureRoot ? String(request.FixtureRoot) : undefined,
                RealLogPath: Array.isArray(request.RealLogPath) ? request.RealLogPath.map(String) : [],
                Backend: request.Backend ? String(request.Backend) : undefined,
                Model: request.Model ? String(request.Model) : undefined,
            });
            break;
        case 'find-files':
            result = (0, find_files_js_1.findFiles)(request.Name.map(String), request.Path ? String(request.Path) : '.');
            break;
        case 'codex-policy':
            result = await (0, install_js_1.installCodexPolicy)(request.CodexHome ? String(request.CodexHome) : undefined, Boolean(request.Force));
            break;
        case 'install-global':
            result = await (0, install_js_1.installShellIntegration)({
                BinDir: request.BinDir ? String(request.BinDir) : undefined,
                ModuleInstallRoot: request.ModuleRoot ? String(request.ModuleRoot) : undefined,
                Force: Boolean(request.Force),
            });
            break;
        case 'interactive-capture':
            result = await (0, interactive_js_1.runInteractiveCapture)({
                Command: String(request.Command),
                ArgumentList: Array.isArray(request.ArgumentList) ? request.ArgumentList.map(String) : [],
                Question: request.Question ? String(request.Question) : undefined,
                Format: request.Format === 'json' ? 'json' : 'text',
                Backend: request.Backend ? String(request.Backend) : undefined,
                Model: request.Model ? String(request.Model) : undefined,
                PolicyProfile: request.PolicyProfile,
            });
            break;
        case 'repo-search':
            result = await (0, repo_search_js_1.executeRepoSearchRequest)({
                prompt: String(request.Prompt || ''),
                repoRoot: String(request.RepoRoot || process.cwd()),
                model: request.Model ? String(request.Model) : undefined,
                maxTurns: request.MaxTurns === undefined ? undefined : Number(request.MaxTurns),
                logFile: request.LogFile ? String(request.LogFile) : undefined,
                availableModels: Array.isArray(request.AvailableModels) ? request.AvailableModels.map(String) : undefined,
                mockResponses: Array.isArray(request.MockResponses) ? request.MockResponses.map(String) : undefined,
                mockCommandResults: (request.MockCommandResults
                    && typeof request.MockCommandResults === 'object'
                    && !Array.isArray(request.MockCommandResults)) ? request.MockCommandResults : undefined,
            });
            break;
        default:
            throw new Error(`Unknown internal op: ${parsed.op}`);
    }
    options.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
}
async function runCli(options) {
    const stdout = options.stdout || process.stdout;
    const stderr = options.stderr || process.stderr;
    if (options.argv.length === 0 || ['help', '--help', '--h', '-h', '-help'].includes(options.argv[0])) {
        showHelp(stdout);
        return 0;
    }
    const commandName = getCommandName(options.argv);
    if (BLOCKED_PUBLIC_COMMANDS.has(options.argv[0])) {
        stderr.write(`Command '${options.argv[0]}' is not exposed in this CLI build. Available commands: summary, repo-search, help.\n`);
        return 1;
    }
    const commandArgs = getCommandArgs(options.argv);
    const commandHelpRequested = commandArgs.some((token) => token === '-h' || token === '--h' || token === '--help' || token === '-help');
    try {
        if (commandName === 'repo-search' && commandHelpRequested) {
            return await runRepoSearchCli({ argv: options.argv, stdout });
        }
        if (SERVER_DEPENDENT_COMMANDS.has(commandName)) {
            await (0, config_js_1.ensureStatusServerReachable)();
        }
        switch (commandName) {
            case 'summary':
                return await runSummary({ argv: options.argv, stdinText: options.stdinText, stdout });
            case 'install':
                return await runInstall(stdout);
            case 'config-get':
                return await runConfigGet(stdout);
            case 'config-set':
                return await runConfigSet({ argv: options.argv, stdout });
            case 'run':
                return await runCommandCli({ argv: options.argv, stdout });
            case 'eval':
                return await runEvalCli({ argv: options.argv, stdout });
            case 'codex-policy':
                return await runCodexPolicyCli({ argv: options.argv, stdout });
            case 'install-global':
                return await runInstallGlobalCli({ argv: options.argv, stdout });
            case 'capture-internal':
                return await runCaptureInternalCli({ argv: options.argv, stdout });
            case 'repo-search':
                return await runRepoSearchCli({ argv: options.argv, stdout });
            case 'find-files':
                return await runFindFiles({ argv: options.argv, stdout });
            case 'test':
                return await runTest(stdout);
            case 'internal':
                return await runInternal({ argv: options.argv, stdout });
            default:
                return 127;
        }
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        stderr.write(`${message}\n`);
        return 1;
    }
}
if (require.main === module) {
    void (async () => {
        let stdinText = '';
        if (!process.stdin.isTTY) {
            stdinText = await new Promise((resolve, reject) => {
                let collected = '';
                process.stdin.setEncoding('utf8');
                process.stdin.on('data', (chunk) => {
                    collected += chunk;
                });
                process.stdin.on('end', () => resolve(collected));
                process.stdin.on('error', reject);
            });
        }
        const exitCode = await runCli({
            argv: process.argv.slice(2),
            stdinText,
        });
        process.exit(exitCode);
    })();
}
