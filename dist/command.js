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
exports.analyzeCommandOutput = analyzeCommandOutput;
exports.runCommand = runCommand;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const node_child_process_1 = require("node:child_process");
const config_js_1 = require("./config.js");
const summary_js_1 = require("./summary.js");
const execution_lock_js_1 = require("./execution-lock.js");
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
function invokeProcess(command, argumentList = []) {
    const runChild = (executable, shell) => (0, node_child_process_1.spawnSync)(executable, argumentList, {
        encoding: 'utf8',
        shell,
        windowsHide: true,
        cwd: process.cwd(),
    });
    let result = runChild(command, false);
    if (result.error && /ENOENT/iu.test(result.error.message || '')) {
        try {
            result = runChild(resolveExternalCommand(command), false);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return {
                ExitCode: 1,
                StdOut: '',
                StdErr: message,
                Combined: message,
            };
        }
    }
    if (result.error && /EPERM|EACCES/iu.test(result.error.message || '')) {
        result = runChild(command, true);
    }
    const stdout = result.stdout || '';
    const stderr = `${result.stderr || ''}${result.error ? `${result.stderr ? '\n' : ''}${result.error.message}` : ''}`;
    return {
        ExitCode: typeof result.status === 'number' ? result.status : 1,
        StdOut: stdout,
        StdErr: stderr,
        Combined: `${stdout}${stdout && stderr ? '\n' : ''}${stderr}`.trim(),
    };
}
function compressRepeatedLines(lines) {
    if (lines.length === 0) {
        return [];
    }
    const result = [];
    let current = lines[0];
    let count = 1;
    for (let index = 1; index < lines.length; index += 1) {
        if (lines[index] === current) {
            count += 1;
            continue;
        }
        if (count > 3) {
            result.push(`${current} [repeated ${count} times]`);
        }
        else {
            for (let repeat = 0; repeat < count; repeat += 1) {
                result.push(current);
            }
        }
        current = lines[index];
        count = 1;
    }
    if (count > 3) {
        result.push(`${current} [repeated ${count} times]`);
    }
    else {
        for (let repeat = 0; repeat < count; repeat += 1) {
            result.push(current);
        }
    }
    return result;
}
function getErrorContextLines(lines) {
    const pattern = /(error|exception|failed|fatal|denied|timeout|traceback|panic|duplicate key|destroy)/iu;
    const indexes = lines.reduce((result, line, index) => {
        if (pattern.test(line)) {
            result.push(index);
        }
        return result;
    }, []);
    if (indexes.length === 0) {
        return [];
    }
    const selected = [];
    const seen = new Set();
    for (const index of indexes) {
        const start = Math.max(index - 2, 0);
        const end = Math.min(index + 2, lines.length - 1);
        for (let cursor = start; cursor <= end; cursor += 1) {
            if (!seen.has(cursor)) {
                seen.add(cursor);
                selected.push(lines[cursor]);
            }
        }
    }
    return selected;
}
function reduceText(text, reducerProfile) {
    if (reducerProfile === 'none') {
        return text;
    }
    const lines = text.length > 0 ? text.replace(/\r\n/gu, '\n').split('\n') : [];
    if (lines.length <= 200) {
        return text;
    }
    const compressed = compressRepeatedLines(lines);
    switch (reducerProfile) {
        case 'errors': {
            const context = getErrorContextLines(compressed);
            return context.length > 0 ? context.join('\n') : compressed.slice(-120).join('\n');
        }
        case 'tail':
            return compressed.slice(-160).join('\n');
        case 'diff': {
            const diffLines = compressed.filter((line) => /^(diff --git|\+\+\+|---|@@|\+[^+]|-[^-]|index\s|rename |new file mode|deleted file mode)/u.test(line));
            return diffLines.length > 0 ? diffLines.join('\n') : compressed.slice(0, 80).join('\n');
        }
        default: {
            const context = getErrorContextLines(compressed);
            if (context.length > 0) {
                return [...compressed.slice(0, 20), '', ...context, '', ...compressed.slice(-40)].join('\n');
            }
            return [...compressed.slice(0, 40), '', ...compressed.slice(-80)].join('\n');
        }
    }
}
async function analyzeCommandOutput(request) {
    const config = await (0, config_js_1.loadConfig)({ ensure: true });
    const backend = request.Backend || config.Backend;
    const model = request.Model || (0, config_js_1.getConfiguredModel)(config);
    const paths = (0, config_js_1.initializeRuntime)();
    const combinedText = request.CombinedText || '';
    const rawLogPath = newArtifactPath(paths.Logs, 'command_raw', 'log');
    (0, config_js_1.saveContentAtomically)(rawLogPath, combinedText);
    const question = request.Question || 'Summarize the main result and any actionable failures.';
    const riskLevel = request.RiskLevel || 'informational';
    const reducerProfile = request.ReducerProfile || 'smart';
    const format = request.Format || 'text';
    const policyProfile = request.PolicyProfile || 'general';
    const decision = (0, summary_js_1.getSummaryDecision)(combinedText, question, riskLevel, config);
    const reducedText = reduceText(combinedText, reducerProfile);
    const deterministicExcerpt = (0, summary_js_1.getDeterministicExcerpt)(combinedText, question);
    let reducedLogPath = null;
    if (reducedText !== combinedText) {
        reducedLogPath = newArtifactPath(paths.Logs, 'command_reduced', 'log');
        (0, config_js_1.saveContentAtomically)(reducedLogPath, reducedText);
    }
    if (request.NoSummarize || !decision.ShouldSummarize) {
        return {
            ExitCode: request.ExitCode,
            RawLogPath: rawLogPath,
            ReducedLogPath: reducedLogPath,
            WasSummarized: false,
            PolicyDecision: request.NoSummarize ? 'no-summarize' : decision.Reason,
            Classification: 'no-summarize',
            RawReviewRequired: decision.RawReviewRequired,
            ModelCallSucceeded: false,
            ProviderError: null,
            Summary: deterministicExcerpt ? `Raw review required.\nRaw log: ${rawLogPath}\n${deterministicExcerpt}` : null,
        };
    }
    const effectiveProfile = ((riskLevel === 'debug' || riskLevel === 'risky') && policyProfile === 'general')
        ? 'risky-operation'
        : policyProfile;
    const summaryResult = await (0, summary_js_1.summarizeRequest)({
        question,
        inputText: combinedText,
        format,
        policyProfile: effectiveProfile,
        backend,
        model,
        sourceKind: 'command-output',
        commandExitCode: request.ExitCode,
    });
    const summaryText = summaryResult.RawReviewRequired && summaryResult.Classification !== 'unsupported_input' && summaryResult.Summary.trim()
        ? `${summaryResult.Summary.trim()}\nRaw log: ${rawLogPath}`
        : summaryResult.Summary;
    return {
        ExitCode: request.ExitCode,
        RawLogPath: rawLogPath,
        ReducedLogPath: reducedLogPath,
        WasSummarized: summaryResult.WasSummarized,
        PolicyDecision: summaryResult.PolicyDecision,
        Classification: summaryResult.Classification,
        RawReviewRequired: summaryResult.RawReviewRequired,
        ModelCallSucceeded: summaryResult.ModelCallSucceeded,
        ProviderError: summaryResult.ProviderError,
        Summary: summaryText,
    };
}
async function runCommand(request) {
    return (0, execution_lock_js_1.withExecutionLock)(async () => {
        const processResult = invokeProcess(request.Command, request.ArgumentList || []);
        return analyzeCommandOutput({
            ExitCode: processResult.ExitCode,
            CombinedText: processResult.Combined,
            Question: request.Question,
            RiskLevel: request.RiskLevel,
            ReducerProfile: request.ReducerProfile,
            Format: request.Format,
            PolicyProfile: request.PolicyProfile,
            Backend: request.Backend,
            Model: request.Model,
            NoSummarize: request.NoSummarize,
        });
    });
}
