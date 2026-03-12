import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ensureDirectory, findOllamaExecutable, getConfigPath, getInferenceStatusPath, initializeRuntime, loadConfig, saveConfig, saveContentAtomically } from './config.js';
import { listOllamaModels } from './providers/ollama.js';
import { withExecutionLock } from './execution-lock.js';

const CODEX_POLICY_START = '<!-- SiftKit Policy:Start -->';
const CODEX_POLICY_END = '<!-- SiftKit Policy:End -->';

function getRepoRoot(): string {
  return path.resolve(__dirname, '..', '..');
}

function getModuleRoot(): string {
  return path.join(getRepoRoot(), 'SiftKit');
}

function getShellIntegrationScript(): string {
  return [
    'Import-Module SiftKit -Force',
    'Enable-SiftInteractiveShellIntegration',
    '',
  ].join('\n');
}

function copyDirectoryContents(source: string, destination: string): void {
  ensureDirectory(destination);
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

function getCodexPolicyBlock(): string {
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

function getPm2ServiceName(): string {
  return 'siftkit-config-service';
}

function getStartupFolderPath(): string {
  return path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
}

function installPm2(skipInstall?: boolean): {
  Installed: boolean;
  Command: string;
  Skipped: boolean;
} {
  if (skipInstall || process.env.SIFTKIT_SKIP_PM2_INSTALL === '1') {
    return {
      Installed: false,
      Command: 'pm2',
      Skipped: true,
    };
  }

  const whereResult = spawnSync('where', ['pm2.cmd'], { encoding: 'utf8', shell: true });
  if (whereResult.status === 0 && whereResult.stdout.trim()) {
    return {
      Installed: true,
      Command: whereResult.stdout.split(/\r?\n/u)[0].trim(),
      Skipped: false,
    };
  }

  spawnSync('npm', ['install', '-g', 'pm2'], { encoding: 'utf8', shell: true });
  const retry = spawnSync('where', ['pm2.cmd'], { encoding: 'utf8', shell: true });
  if (retry.status !== 0 || !retry.stdout.trim()) {
    throw new Error('pm2 was not found after npm install -g pm2.');
  }

  return {
    Installed: true,
    Command: retry.stdout.split(/\r?\n/u)[0].trim(),
    Skipped: false,
  };
}

function getPm2BootstrapScript(nodeScriptPath: string, statusPath: string): string {
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

function getPm2StopScript(serviceName: string): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    "$pm2 = Get-Command pm2.cmd, pm2 -ErrorAction Stop | Select-Object -First 1",
    `& $pm2.Source delete '${serviceName.replace(/'/gu, "''")}' 2>$null | Out-Null`,
    '& $pm2.Source save | Out-Host',
    '',
  ].join('\n');
}

function getStartupLauncherContent(bootstrapScriptPath: string): string {
  return `@echo off\r\npowershell.exe -ExecutionPolicy Bypass -File "${bootstrapScriptPath}"\r\n`;
}

export async function installSiftKit(force?: boolean): Promise<Record<string, unknown>> {
  return withExecutionLock(async () => {
    const paths = initializeRuntime();
    let config = await loadConfig({ ensure: true });
    config.Paths = paths;
    config.Ollama.ExecutablePath = findOllamaExecutable();

    if (force || !fs.existsSync(getConfigPath())) {
      await saveConfig(config, { allowLocalFallback: true });
    } else {
      config = await loadConfig({ ensure: true });
    }

    let models: string[] = [];
    try {
      if (config.Backend === 'ollama') {
        models = await listOllamaModels(config);
      }
    } catch {
      models = [];
    }

    return {
      Installed: true,
      ConfigPath: getConfigPath(),
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

export async function installCodexPolicy(codexHome?: string, force?: boolean): Promise<Record<string, unknown>> {
  return withExecutionLock(async () => {
    const targetCodexHome = codexHome || path.join(process.env.USERPROFILE || '', '.codex');
    ensureDirectory(targetCodexHome);
    const agentsPath = path.join(targetCodexHome, 'AGENTS.md');
    const policyBlock = getCodexPolicyBlock();
    let updated: string;

    if (fs.existsSync(agentsPath)) {
      const existing = fs.readFileSync(agentsPath, 'utf8');
      if (existing.includes(CODEX_POLICY_START)) {
        const pattern = new RegExp(`${CODEX_POLICY_START}[\\s\\S]*?${CODEX_POLICY_END}`, 'u');
        updated = existing.replace(pattern, policyBlock.trimEnd());
      } else if (force || existing.trim()) {
        updated = `${existing.trimEnd()}\n\n${policyBlock}`;
      } else {
        updated = policyBlock;
      }
    } else {
      updated = policyBlock;
    }

    saveContentAtomically(agentsPath, updated.endsWith('\n') ? updated : `${updated}\n`);
    return {
      AgentsPath: agentsPath,
      Installed: true,
    };
  });
}

export async function installShellIntegration(options?: {
  BinDir?: string;
  ModuleInstallRoot?: string;
  Force?: boolean;
}): Promise<Record<string, unknown>> {
  return withExecutionLock(async () => {
    const binDir = options?.BinDir || path.join(process.env.USERPROFILE || '', 'bin');
    const moduleInstallRoot = options?.ModuleInstallRoot || path.join(process.env.USERPROFILE || '', 'Documents', 'WindowsPowerShell', 'Modules');
    const moduleSource = getModuleRoot();
    const repoRoot = getRepoRoot();
    const moduleTarget = path.join(moduleInstallRoot, 'SiftKit');
    const distSource = path.join(repoRoot, 'dist');
    const distTarget = path.join(moduleTarget, 'dist');
    const binSource = path.join(repoRoot, 'bin');

    ensureDirectory(moduleInstallRoot);
    ensureDirectory(binDir);

    if (fs.existsSync(moduleTarget) && options?.Force) {
      fs.rmSync(moduleTarget, { recursive: true, force: true });
    }

    ensureDirectory(moduleTarget);
    copyDirectoryContents(moduleSource, moduleTarget);
    if (fs.existsSync(distSource)) {
      copyDirectoryContents(distSource, distTarget);
    }
    fs.copyFileSync(path.join(binSource, 'siftkit.ps1'), path.join(binDir, 'siftkit.ps1'));
    fs.copyFileSync(path.join(binSource, 'siftkit.cmd'), path.join(binDir, 'siftkit.cmd'));
    const shellIntegrationPath = path.join(binDir, 'siftkit-shell.ps1');
    saveContentAtomically(shellIntegrationPath, getShellIntegrationScript());

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

export async function installService(options?: {
  BinDir?: string;
  StartupDir?: string;
  StatusPath?: string;
  SkipPm2Install?: boolean;
  SkipPm2Bootstrap?: boolean;
}): Promise<Record<string, unknown>> {
  return withExecutionLock(async () => {
    const repoRoot = getRepoRoot();
    const nodeScriptPath = path.join(repoRoot, 'bin', 'siftkit.js');
    const serviceName = getPm2ServiceName();
    const statusPath = path.resolve(options?.StatusPath || getInferenceStatusPath());
    const statusPort = process.env.SIFTKIT_STATUS_PORT || '4765';
    const binDir = options?.BinDir || path.join(process.env.USERPROFILE || '', 'bin');
    const startupDir = options?.StartupDir || getStartupFolderPath();

    ensureDirectory(binDir);
    ensureDirectory(startupDir);
    const bootstrapScriptPath = path.join(binDir, 'siftkit-service-bootstrap.ps1');
    const stopScriptPath = path.join(binDir, 'siftkit-service-stop.ps1');
    const startupLauncherPath = path.join(startupDir, 'siftkit-service-startup.cmd');

    saveContentAtomically(bootstrapScriptPath, getPm2BootstrapScript(nodeScriptPath, statusPath));
    saveContentAtomically(stopScriptPath, getPm2StopScript(serviceName));
    saveContentAtomically(startupLauncherPath, getStartupLauncherContent(bootstrapScriptPath));

    const pm2Status = installPm2(options?.SkipPm2Install);
    if (!options?.SkipPm2Bootstrap) {
      spawnSync('powershell.exe', ['-ExecutionPolicy', 'Bypass', '-File', bootstrapScriptPath], {
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

export async function uninstallService(options?: {
  BinDir?: string;
  StartupDir?: string;
  SkipPm2Bootstrap?: boolean;
}): Promise<Record<string, unknown>> {
  return withExecutionLock(async () => {
    const serviceName = getPm2ServiceName();
    const binDir = options?.BinDir || path.join(process.env.USERPROFILE || '', 'bin');
    const startupDir = options?.StartupDir || getStartupFolderPath();
    const stopScriptPath = path.join(binDir, 'siftkit-service-stop.ps1');
    const startupLauncherPath = path.join(startupDir, 'siftkit-service-startup.cmd');

    if (fs.existsSync(stopScriptPath) && !options?.SkipPm2Bootstrap) {
      spawnSync('powershell.exe', ['-ExecutionPolicy', 'Bypass', '-File', stopScriptPath], {
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
