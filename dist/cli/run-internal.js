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
exports.runInternal = runInternal;
const fs = __importStar(require("node:fs"));
const index_js_1 = require("../config/index.js");
const command_js_1 = require("../command.js");
const eval_js_1 = require("../eval.js");
const find_files_js_1 = require("../find-files.js");
const install_js_1 = require("../install.js");
const interactive_js_1 = require("../interactive.js");
const index_js_2 = require("../repo-search/index.js");
const summary_js_1 = require("../summary.js");
const args_js_1 = require("./args.js");
const run_test_js_1 = require("./run-test.js");
function readRequestFile(filePath) {
    const text = fs.readFileSync(filePath, 'utf8');
    const normalized = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
    return JSON.parse(normalized);
}
async function runInternal(options) {
    const parsed = (0, args_js_1.parseArguments)((0, args_js_1.getCommandArgs)(options.argv));
    if (!parsed.op) {
        throw new Error('An --op is required.');
    }
    if (!parsed.requestFile) {
        throw new Error('A --request-file is required.');
    }
    if (args_js_1.SERVER_DEPENDENT_INTERNAL_OPS.has(parsed.op)) {
        await (0, index_js_1.ensureStatusServerReachable)();
    }
    const request = readRequestFile(parsed.requestFile);
    let result;
    switch (parsed.op) {
        case 'install':
            result = await (0, install_js_1.installSiftKit)(Boolean(request.Force));
            break;
        case 'test':
            result = await (0, run_test_js_1.buildTestResult)();
            break;
        case 'config-get':
            result = await (0, index_js_1.loadConfig)({ ensure: true });
            break;
        case 'config-set':
            result = await (0, index_js_1.setTopLevelConfigKey)(String(request.Key), request.Value);
            break;
        case 'summary': {
            const text = request.TextFile ? fs.readFileSync(String(request.TextFile), 'utf8') : String(request.Text || '');
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
            result = await (0, index_js_2.executeRepoSearchRequest)({
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
