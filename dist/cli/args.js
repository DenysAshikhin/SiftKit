"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SERVER_DEPENDENT_INTERNAL_OPS = exports.SERVER_DEPENDENT_COMMANDS = exports.BLOCKED_PUBLIC_COMMANDS = exports.KNOWN_COMMANDS = void 0;
exports.getCommandName = getCommandName;
exports.getCommandArgs = getCommandArgs;
exports.validateRepoSearchTokens = validateRepoSearchTokens;
exports.parseArguments = parseArguments;
exports.formatPsList = formatPsList;
const node_util_1 = require("node:util");
exports.KNOWN_COMMANDS = new Set([
    'summary',
    'repo-search',
    'find-files',
    'internal',
]);
exports.BLOCKED_PUBLIC_COMMANDS = new Set([
    'run',
    'install',
    'test',
    'eval',
    'codex-policy',
    'install-global',
    'config-get',
    'config-set',
    'capture-internal',
]);
exports.SERVER_DEPENDENT_COMMANDS = new Set([
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
exports.SERVER_DEPENDENT_INTERNAL_OPS = new Set([
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
    if (argv.length > 0 && exports.KNOWN_COMMANDS.has(argv[0])) {
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
    if (commandName === 'summary' && (argv.length === 0 || !exports.KNOWN_COMMANDS.has(argv[0]))) {
        return argv;
    }
    return argv.slice(1);
}
function validateRepoSearchTokens(tokens) {
    const flagsWithValues = new Set(['--prompt', '-prompt', '--model', '--max-turns', '--log-file']);
    const helpFlags = new Set(['-h', '--h', '--help', '-help']);
    for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index];
        if (helpFlags.has(token)) {
            continue;
        }
        if (flagsWithValues.has(token)) {
            if (tokens[index + 1] === undefined) {
                throw new Error(`Missing value for repo-search option: ${token}`);
            }
            index += 1;
            continue;
        }
        if (token.startsWith('-')) {
            throw new Error(`Unknown option for repo-search: ${token}`);
        }
    }
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
