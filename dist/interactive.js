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
exports.runInteractiveCapture = runInteractiveCapture;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const node_child_process_1 = require("node:child_process");
const config_js_1 = require("./config.js");
const summary_js_1 = require("./summary.js");
function getTimestamp() {
    const current = new Date();
    const yyyy = current.getFullYear();
    const MM = String(current.getMonth() + 1).padStart(2, '0');
    const dd = String(current.getDate()).padStart(2, '0');
    const hh = String(current.getHours()).padStart(2, '0');
    const mm = String(current.getMinutes()).padStart(2, '0');
    const ss = String(current.getSeconds()).padStart(2, '0');
    const fff = String(current.getMilliseconds()).padStart(3, '0');
    return `${yyyy}${MM}${dd}_${hh}${mm}${ss}_${fff}`;
}
function newArtifactPath(directory, prefix, extension) {
    const safeExtension = extension.replace(/^\./u, '');
    const suffix = `${getTimestamp()}_${process.pid}_${Math.random().toString(16).slice(2, 10)}`;
    return path.join(directory, `${prefix}_${suffix}.${safeExtension}`);
}
function findCommandInPath(commandName) {
    const pathEntries = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
    const candidates = process.platform === 'win32' && !path.extname(commandName)
        ? [commandName, `${commandName}.exe`, `${commandName}.cmd`, `${commandName}.bat`]
        : [commandName];
    for (const entry of pathEntries) {
        for (const candidate of candidates) {
            const fullPath = path.join(entry, candidate);
            if (fs.existsSync(fullPath)) {
                return fullPath;
            }
        }
    }
    if (process.platform === 'win32') {
        const windowsRoot = process.env.WINDIR || 'C:\\Windows';
        const extraCandidates = [
            path.join(windowsRoot, 'System32', commandName),
            path.join(windowsRoot, 'System32', `${commandName}.exe`),
            path.join(windowsRoot, 'System32', 'WindowsPowerShell', 'v1.0', commandName),
            path.join(windowsRoot, 'System32', 'WindowsPowerShell', 'v1.0', `${commandName}.exe`),
        ];
        for (const candidate of extraCandidates) {
            if (fs.existsSync(candidate)) {
                return candidate;
            }
        }
    }
    return null;
}
function resolveExternalCommand(commandName) {
    if (path.isAbsolute(commandName) || commandName.includes('\\') || commandName.includes('/')) {
        if (fs.existsSync(commandName)) {
            return commandName;
        }
        throw new Error(`Unable to resolve external command: ${commandName}`);
    }
    const direct = (0, node_child_process_1.spawnSync)('where.exe', [commandName], { encoding: 'utf8', shell: false, windowsHide: true });
    if (direct.status === 0 && direct.stdout.trim()) {
        return direct.stdout.split(/\r?\n/u)[0].trim();
    }
    const fallback = findCommandInPath(commandName);
    if (fallback) {
        return fallback;
    }
    throw new Error(`Unable to resolve external command: ${commandName}`);
}
function quoteForPowerShell(value) {
    return `'${value.replace(/'/gu, "''")}'`;
}
function captureWithTranscript(commandPath, argumentList, transcriptPath) {
    const joinedArgs = argumentList.map((entry) => quoteForPowerShell(entry)).join(', ');
    const script = [
        "$ErrorActionPreference = 'Stop'",
        `$transcriptPath = ${quoteForPowerShell(transcriptPath)}`,
        `$commandPath = ${quoteForPowerShell(commandPath)}`,
        `Start-Transcript -Path $transcriptPath -Force | Out-Null`,
        'try {',
        `  & $commandPath @(${joinedArgs})`,
        '  if ($null -ne $LASTEXITCODE) { exit [int]$LASTEXITCODE }',
        '  exit 0',
        '} finally {',
        '  try { Stop-Transcript | Out-Null } catch {}',
        '}',
    ].join('\n');
    const result = (0, node_child_process_1.spawnSync)('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
        encoding: 'utf8',
        stdio: 'ignore',
        windowsHide: false,
    });
    return typeof result.status === 'number' ? result.status : 1;
}
async function runInteractiveCapture(request) {
    const config = await (0, config_js_1.loadConfig)({ ensure: true });
    const backend = request.Backend || config.Backend;
    const model = request.Model || config.Model;
    const format = request.Format || 'text';
    const policyProfile = request.PolicyProfile || 'general';
    const question = request.Question || 'Summarize the important result and any actionable failures.';
    const paths = (0, config_js_1.initializeRuntime)();
    const transcriptPath = newArtifactPath(paths.Logs, 'interactive_raw', 'log');
    const resolvedCommand = resolveExternalCommand(request.Command);
    let exitCode = 0;
    try {
        exitCode = captureWithTranscript(resolvedCommand, request.ArgumentList || [], transcriptPath);
    }
    catch {
        (0, config_js_1.saveContentAtomically)(transcriptPath, '');
        exitCode = 1;
    }
    let transcriptText = fs.existsSync(transcriptPath) ? fs.readFileSync(transcriptPath, 'utf8') : '';
    if (config.Interactive.MaxTranscriptCharacters && transcriptText.length > Number(config.Interactive.MaxTranscriptCharacters)) {
        transcriptText = transcriptText.substring(transcriptText.length - Number(config.Interactive.MaxTranscriptCharacters));
        (0, config_js_1.saveContentAtomically)(transcriptPath, transcriptText);
    }
    if (!transcriptText.trim()) {
        transcriptText = `Interactive command completed without a captured transcript.\nCommand: ${request.Command} ${(request.ArgumentList || []).join(' ')}\nExitCode: ${exitCode}`;
        (0, config_js_1.saveContentAtomically)(transcriptPath, transcriptText);
    }
    const summaryResult = await (0, summary_js_1.summarizeRequest)({
        question,
        inputText: transcriptText,
        format,
        backend,
        model,
        policyProfile,
    });
    const outputText = `${(summaryResult.Summary || 'No summary generated.').trim()}\nRaw transcript: ${transcriptPath}`;
    return {
        ExitCode: exitCode,
        TranscriptPath: transcriptPath,
        WasSummarized: summaryResult.WasSummarized,
        RawReviewRequired: summaryResult.PolicyDecision.startsWith('raw-first') || exitCode !== 0,
        OutputText: outputText,
        Summary: summaryResult.Summary,
    };
}
