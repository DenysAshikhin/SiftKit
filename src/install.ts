import { existsSync, readFileSync, rmSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { getActiveInferenceBackend, getConfigPath, getConfiguredEngineBaseUrl, getConfiguredModel, initializeRuntime, loadConfig } from './config/index.ts';
import { ensureDirectory, saveContentAtomically } from './lib/fs.ts';
import { findNearestSiftKitRepoRoot, moduleDirname } from './lib/paths.ts';
import { getInferenceProviderStatus, listInferenceModels } from './providers/inference.ts';

const CODEX_POLICY_START = '<!-- SiftKit Policy:Start -->';
const CODEX_POLICY_END = '<!-- SiftKit Policy:End -->';

function getRepoRoot(): string {
  const packageRoot = findNearestSiftKitRepoRoot(moduleDirname(import.meta.url));
  if (packageRoot === null) {
    throw new Error('Unable to locate the SiftKit package root for installation.');
  }
  return packageRoot;
}

function getModuleRoot(): string {
  return join(getRepoRoot(), 'SiftKit');
}

function getShellIntegrationScript(): string {
  return [
    'Import-Module SiftKit -Force',
    'Enable-SiftInteractiveShellIntegration',
    '',
  ].join('\n');
}

const MODULE_MANIFEST = 'SiftKit.psd1';
const ROOT_MODULE_LINE = "RootModule = 'SiftKit.psm1'";

// The installed manifest loads this checkout's module by absolute path, so the module resolves this repo.
function getInstalledModuleManifest(): string {
  const manifest = readFileSync(join(getModuleRoot(), MODULE_MANIFEST), 'utf8');
  if (!manifest.includes(ROOT_MODULE_LINE)) {
    throw new Error(`${MODULE_MANIFEST} no longer declares ${ROOT_MODULE_LINE}.`);
  }
  const rootModulePath = join(getModuleRoot(), 'SiftKit.psm1').replace(/'/gu, "''");
  return manifest.replace(ROOT_MODULE_LINE, `RootModule = '${rootModulePath}'`);
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

export type InstallSiftKitResult = {
  Installed: true;
  ConfigPath: string;
  RuntimeRoot: string;
  LogsPath: string;
  EvalResultsPath: string;
  Backend: string;
  Model: string | null;
  InferenceBaseUrl: string | null;
  InferenceReachable: boolean;
  AvailableModels: string[];
};

export async function installSiftKit(force?: boolean): Promise<InstallSiftKitResult> {
  void force;
  const paths = initializeRuntime();
  const config = await loadConfig({ ensure: true });
  const engine = getActiveInferenceBackend(config);

  let models: string[] = [];
  let providerReachable = false;
  try {
    const providerStatus = await getInferenceProviderStatus(config);
    providerReachable = Boolean(providerStatus.Reachable);
    models = providerReachable ? await listInferenceModels(config) : [];
  } catch {
    models = [];
  }

  return {
    Installed: true,
    ConfigPath: getConfigPath(),
    RuntimeRoot: paths.RuntimeRoot,
    LogsPath: paths.Logs,
    EvalResultsPath: paths.EvalResults,
    Backend: engine,
    Model: getConfiguredModel(config),
    InferenceBaseUrl: getConfiguredEngineBaseUrl(config),
    InferenceReachable: providerReachable,
    AvailableModels: models,
  };
}

export type InstallCodexPolicyResult = {
  AgentsPath: string;
  Installed: true;
};

export async function installCodexPolicy(codexHome?: string, force?: boolean): Promise<InstallCodexPolicyResult> {
  const targetCodexHome = codexHome || join(process.env.USERPROFILE || '', '.codex');
  ensureDirectory(targetCodexHome);
  const agentsPath = join(targetCodexHome, 'AGENTS.md');
  const policyBlock = getCodexPolicyBlock();
  let updated: string;

  if (existsSync(agentsPath)) {
    const existing = readFileSync(agentsPath, 'utf8');
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
}

export type InstallShellIntegrationResult = {
  Installed: true;
  ModulePath: string;
  BinDir: string;
  PowerShellShim: string;
  CmdShim: string;
  ShellIntegrationScript: string;
  PathHint: string;
  ProfileHint: string;
};

export async function installShellIntegration(options?: {
  BinDir?: string;
  ModuleInstallRoot?: string;
  Force?: boolean;
}): Promise<InstallShellIntegrationResult> {
  const binDir = options?.BinDir || join(process.env.USERPROFILE || '', 'bin');
  const moduleInstallRoot = options?.ModuleInstallRoot || join(process.env.USERPROFILE || '', 'Documents', 'WindowsPowerShell', 'Modules');
  const repoRoot = getRepoRoot();
  const moduleTarget = join(moduleInstallRoot, 'SiftKit');
  const binSource = join(repoRoot, 'bin');

  ensureDirectory(moduleInstallRoot);
  ensureDirectory(binDir);

  if (existsSync(moduleTarget) && options?.Force) {
    rmSync(moduleTarget, { recursive: true, force: true });
  }

  ensureDirectory(moduleTarget);
  saveContentAtomically(join(moduleTarget, MODULE_MANIFEST), getInstalledModuleManifest());
  copyFileSync(join(binSource, 'siftkit.ps1'), join(binDir, 'siftkit.ps1'));
  copyFileSync(join(binSource, 'siftkit.cmd'), join(binDir, 'siftkit.cmd'));
  const shellIntegrationPath = join(binDir, 'siftkit-shell.ps1');
  saveContentAtomically(shellIntegrationPath, getShellIntegrationScript());

  return {
    Installed: true,
    ModulePath: moduleTarget,
    BinDir: binDir,
    PowerShellShim: join(binDir, 'siftkit.ps1'),
    CmdShim: join(binDir, 'siftkit.cmd'),
    ShellIntegrationScript: shellIntegrationPath,
    PathHint: 'Add the bin directory to PATH to run siftkit globally.',
    ProfileHint: `. '${shellIntegrationPath}'`,
  };
}
