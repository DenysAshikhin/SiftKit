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
exports.installService = installService;
exports.uninstallService = uninstallService;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const node_child_process_1 = require("node:child_process");
const config_js_1 = require("./config.js");
const ollama_js_1 = require("./providers/ollama.js");
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
function getPm2ServiceName() {
    return 'siftkit-config-service';
}
function getStartupFolderPath() {
    return path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
}
function installPm2(skipInstall) {
    if (skipInstall || process.env.SIFTKIT_SKIP_PM2_INSTALL === '1') {
        return {
            Installed: false,
            Command: 'pm2',
            Skipped: true,
        };
    }
    const whereResult = (0, node_child_process_1.spawnSync)('where', ['pm2.cmd'], { encoding: 'utf8', shell: true });
    if (whereResult.status === 0 && whereResult.stdout.trim()) {
        return {
            Installed: true,
            Command: whereResult.stdout.split(/\r?\n/u)[0].trim(),
            Skipped: false,
        };
    }
    (0, node_child_process_1.spawnSync)('npm', ['install', '-g', 'pm2'], { encoding: 'utf8', shell: true });
    const retry = (0, node_child_process_1.spawnSync)('where', ['pm2.cmd'], { encoding: 'utf8', shell: true });
    if (retry.status !== 0 || !retry.stdout.trim()) {
        throw new Error('pm2 was not found after npm install -g pm2.');
    }
    return {
        Installed: true,
        Command: retry.stdout.split(/\r?\n/u)[0].trim(),
        Skipped: false,
    };
}
function getPm2BootstrapScript(nodeScriptPath, statusPath) {
    return [
        "$ErrorActionPreference = 'Stop'",
        `$serviceName = '${getPm2ServiceName()}'`,
        `$scriptPath = '${nodeScriptPath.replace(/'/gu, "''")}'`,
        `$env:sift_kit_status = '${statusPath.replace(/'/gu, "''")}'`,
        "$pm2 = Get-Command pm2.cmd, pm2 -ErrorAction Stop | Select-Object -First 1",
        '& $pm2.Source delete $serviceName 2>$null | Out-Null',
        '& $pm2.Source start $scriptPath --name $serviceName --interpreter node -- status-server | Out-Host',
        '& $pm2.Source save | Out-Host',
        '',
    ].join('\n');
}
function getPm2StopScript(serviceName) {
    return [
        "$ErrorActionPreference = 'Stop'",
        "$pm2 = Get-Command pm2.cmd, pm2 -ErrorAction Stop | Select-Object -First 1",
        `& $pm2.Source delete '${serviceName.replace(/'/gu, "''")}' 2>$null | Out-Null`,
        '& $pm2.Source save | Out-Host',
        '',
    ].join('\n');
}
function getStartupLauncherContent(bootstrapScriptPath) {
    return `@echo off\r\npowershell.exe -ExecutionPolicy Bypass -File "${bootstrapScriptPath}"\r\n`;
}
async function installSiftKit(force) {
    return (0, execution_lock_js_1.withExecutionLock)(async () => {
        const paths = (0, config_js_1.initializeRuntime)();
        let config = await (0, config_js_1.loadConfig)({ ensure: true });
        config.Paths = paths;
        config.Ollama.ExecutablePath = (0, config_js_1.findOllamaExecutable)();
        if (force || !fs.existsSync((0, config_js_1.getConfigPath)())) {
            await (0, config_js_1.saveConfig)(config, { allowLocalFallback: true });
        }
        else {
            config = await (0, config_js_1.loadConfig)({ ensure: true });
        }
        let models = [];
        try {
            if (config.Backend === 'ollama') {
                models = await (0, ollama_js_1.listOllamaModels)(config);
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
            Model: config.Model,
            OllamaExecutablePath: config.Ollama.ExecutablePath,
            AvailableModels: models,
        };
    });
}
async function installCodexPolicy(codexHome, force) {
    return (0, execution_lock_js_1.withExecutionLock)(async () => {
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
    });
}
async function installShellIntegration(options) {
    return (0, execution_lock_js_1.withExecutionLock)(async () => {
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
    });
}
async function installService(options) {
    return (0, execution_lock_js_1.withExecutionLock)(async () => {
        const repoRoot = getRepoRoot();
        const nodeScriptPath = path.join(repoRoot, 'bin', 'siftkit.js');
        const serviceName = getPm2ServiceName();
        const statusPath = path.resolve(options?.StatusPath || (0, config_js_1.getInferenceStatusPath)());
        const statusPort = process.env.SIFTKIT_STATUS_PORT || '4765';
        const binDir = options?.BinDir || path.join(process.env.USERPROFILE || '', 'bin');
        const startupDir = options?.StartupDir || getStartupFolderPath();
        (0, config_js_1.ensureDirectory)(binDir);
        (0, config_js_1.ensureDirectory)(startupDir);
        const bootstrapScriptPath = path.join(binDir, 'siftkit-service-bootstrap.ps1');
        const stopScriptPath = path.join(binDir, 'siftkit-service-stop.ps1');
        const startupLauncherPath = path.join(startupDir, 'siftkit-service-startup.cmd');
        (0, config_js_1.saveContentAtomically)(bootstrapScriptPath, getPm2BootstrapScript(nodeScriptPath, statusPath));
        (0, config_js_1.saveContentAtomically)(stopScriptPath, getPm2StopScript(serviceName));
        (0, config_js_1.saveContentAtomically)(startupLauncherPath, getStartupLauncherContent(bootstrapScriptPath));
        const pm2Status = installPm2(options?.SkipPm2Install);
        if (!options?.SkipPm2Bootstrap) {
            (0, node_child_process_1.spawnSync)('powershell.exe', ['-ExecutionPolicy', 'Bypass', '-File', bootstrapScriptPath], {
                encoding: 'utf8',
                shell: false,
                windowsHide: true,
            });
        }
        return {
            Installed: true,
            ServiceName: serviceName,
            BootstrapScript: bootstrapScriptPath,
            StopScript: stopScriptPath,
            StartupLauncher: startupLauncherPath,
            StatusPath: statusPath,
            Pm2Command: pm2Status.Command,
            VerificationHint: `pm2 list && Invoke-RestMethod http://127.0.0.1:${statusPort}/health`,
        };
    });
}
async function uninstallService(options) {
    return (0, execution_lock_js_1.withExecutionLock)(async () => {
        const serviceName = getPm2ServiceName();
        const binDir = options?.BinDir || path.join(process.env.USERPROFILE || '', 'bin');
        const startupDir = options?.StartupDir || getStartupFolderPath();
        const stopScriptPath = path.join(binDir, 'siftkit-service-stop.ps1');
        const startupLauncherPath = path.join(startupDir, 'siftkit-service-startup.cmd');
        if (fs.existsSync(stopScriptPath) && !options?.SkipPm2Bootstrap) {
            (0, node_child_process_1.spawnSync)('powershell.exe', ['-ExecutionPolicy', 'Bypass', '-File', stopScriptPath], {
                encoding: 'utf8',
                shell: false,
                windowsHide: true,
            });
        }
        for (const targetPath of [
            path.join(binDir, 'siftkit-service-bootstrap.ps1'),
            stopScriptPath,
            startupLauncherPath,
        ]) {
            if (fs.existsSync(targetPath)) {
                fs.rmSync(targetPath, { force: true });
            }
        }
        return {
            Removed: true,
            ServiceName: serviceName,
            StartupLauncher: startupLauncherPath,
        };
    });
}
