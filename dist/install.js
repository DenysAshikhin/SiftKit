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
exports.installSiftKit = installSiftKit;
exports.installCodexPolicy = installCodexPolicy;
exports.installShellIntegration = installShellIntegration;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const config_js_1 = require("./config.js");
const llama_cpp_js_1 = require("./providers/llama-cpp.js");
const execution_lock_js_1 = require("./execution-lock.js");
const CODEX_POLICY_START = '<!-- SiftKit Policy:Start -->';
const CODEX_POLICY_END = '<!-- SiftKit Policy:End -->';
function getRepoRoot() {
    return path.resolve(__dirname, '..', '..');
}
function getModuleRoot() {
    return path.join(getRepoRoot(), 'SiftKit');
}
function getShellIntegrationScript() {
    return [
        'Import-Module SiftKit -Force',
        'Enable-SiftInteractiveShellIntegration',
        '',
    ].join('\n');
}
function copyDirectoryContents(source, destination) {
    (0, config_js_1.ensureDirectory)(destination);
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
        const sourcePath = path.join(source, entry.name);
        const destinationPath = path.join(destination, entry.name);
        if (entry.isDirectory()) {
            copyDirectoryContents(sourcePath, destinationPath);
            continue;
        }
        fs.copyFileSync(sourcePath, destinationPath);
    }
}
function getCodexPolicyBlock() {
    return [
        CODEX_POLICY_START,
        '# SiftKit default shell-output handling',
        '',
        'Use SiftKit instead of distill for shell-output compression.',
        '',
        '- Prefer deterministic reduction first: quiet flags, JSON output, rg, Select-String, and targeted filters.',
        '- For large informational output, prefer `Invoke-SiftCommand` so raw logs are saved before summarization.',
        '- For direct text or log-file summarization, use `Invoke-SiftSummary`.',
        '- For short output, risky operations, crashes, auth issues, migrations, or exact diagnosis, inspect raw output first.',
        '- Interactive `... | siftkit ...` support is PowerShell-only and depends on the installed shell wrappers for known commands such as `git`, `less`, `vim`, and `sqlite3`.',
        '- If an interactive command is unsupported or not wrapper-backed, do not trust a normal pipe; prefer raw/manual review instead of a lossy summary.',
        '- If SiftKit returns a summary for a risky or debug command, treat it as a lossy secondary summary and review the raw log path before making strong claims.',
        '- When reporting distilled output, say it is a summary and include the raw log path when available.',
        '',
        'Examples:',
        "- `Invoke-SiftCommand -Command pytest -ArgumentList '-q' -Question 'did tests pass? if not, list only failing tests'`",
        "- `Get-Content .\\build.log -Raw | Invoke-SiftSummary -Question 'extract the root exception and first relevant application frame'`",
        '',
        CODEX_POLICY_END,
        '',
    ].join('\n');
}
async function installSiftKit(force) {
    return (0, execution_lock_js_1.withExecutionLock)(async () => {
        void force;
        const paths = (0, config_js_1.initializeRuntime)();
        const config = await (0, config_js_1.loadConfig)({ ensure: true });
        let models = [];
        let providerReachable = false;
        try {
            if (config.Backend === 'llama.cpp') {
                const providerStatus = await (0, llama_cpp_js_1.getLlamaCppProviderStatus)(config);
                providerReachable = Boolean(providerStatus.Reachable);
                models = providerReachable ? await (0, llama_cpp_js_1.listLlamaCppModels)(config) : [];
            }
        }
        catch {
            models = [];
        }
        return {
            Installed: true,
            ConfigPath: (0, config_js_1.getConfigPath)(),
            RuntimeRoot: paths.RuntimeRoot,
            LogsPath: paths.Logs,
            EvalResultsPath: paths.EvalResults,
            Backend: config.Backend,
            Model: (0, config_js_1.getConfiguredModel)(config),
            LlamaCppBaseUrl: (0, config_js_1.getConfiguredLlamaBaseUrl)(config),
            LlamaCppReachable: providerReachable,
            AvailableModels: models,
        };
    });
}
async function installCodexPolicy(codexHome, force) {
    const targetCodexHome = codexHome || path.join(process.env.USERPROFILE || '', '.codex');
    (0, config_js_1.ensureDirectory)(targetCodexHome);
    const agentsPath = path.join(targetCodexHome, 'AGENTS.md');
    const policyBlock = getCodexPolicyBlock();
    let updated;
    if (fs.existsSync(agentsPath)) {
        const existing = fs.readFileSync(agentsPath, 'utf8');
        if (existing.includes(CODEX_POLICY_START)) {
            const pattern = new RegExp(`${CODEX_POLICY_START}[\\s\\S]*?${CODEX_POLICY_END}`, 'u');
            updated = existing.replace(pattern, policyBlock.trimEnd());
        }
        else if (force || existing.trim()) {
            updated = `${existing.trimEnd()}\n\n${policyBlock}`;
        }
        else {
            updated = policyBlock;
        }
    }
    else {
        updated = policyBlock;
    }
    (0, config_js_1.saveContentAtomically)(agentsPath, updated.endsWith('\n') ? updated : `${updated}\n`);
    return {
        AgentsPath: agentsPath,
        Installed: true,
    };
}
async function installShellIntegration(options) {
    const binDir = options?.BinDir || path.join(process.env.USERPROFILE || '', 'bin');
    const moduleInstallRoot = options?.ModuleInstallRoot || path.join(process.env.USERPROFILE || '', 'Documents', 'WindowsPowerShell', 'Modules');
    const moduleSource = getModuleRoot();
    const repoRoot = getRepoRoot();
    const moduleTarget = path.join(moduleInstallRoot, 'SiftKit');
    const distSource = path.join(repoRoot, 'dist');
    const distTarget = path.join(moduleTarget, 'dist');
    const binSource = path.join(repoRoot, 'bin');
    (0, config_js_1.ensureDirectory)(moduleInstallRoot);
    (0, config_js_1.ensureDirectory)(binDir);
    if (fs.existsSync(moduleTarget) && options?.Force) {
        fs.rmSync(moduleTarget, { recursive: true, force: true });
    }
    (0, config_js_1.ensureDirectory)(moduleTarget);
    copyDirectoryContents(moduleSource, moduleTarget);
    if (fs.existsSync(distSource)) {
        copyDirectoryContents(distSource, distTarget);
    }
    fs.copyFileSync(path.join(binSource, 'siftkit.ps1'), path.join(binDir, 'siftkit.ps1'));
    fs.copyFileSync(path.join(binSource, 'siftkit.cmd'), path.join(binDir, 'siftkit.cmd'));
    const shellIntegrationPath = path.join(binDir, 'siftkit-shell.ps1');
    (0, config_js_1.saveContentAtomically)(shellIntegrationPath, getShellIntegrationScript());
    return {
        Installed: true,
        ModulePath: moduleTarget,
        BinDir: binDir,
        PowerShellShim: path.join(binDir, 'siftkit.ps1'),
        CmdShim: path.join(binDir, 'siftkit.cmd'),
        ShellIntegrationScript: shellIntegrationPath,
        PathHint: 'Add the bin directory to PATH to run siftkit globally.',
        ProfileHint: `. '${shellIntegrationPath}'`,
    };
}
