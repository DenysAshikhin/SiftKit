import * as fs from 'node:fs';
import * as path from 'node:path';
import { ensureDirectory, findOllamaExecutable, getConfigPath, initializeRuntime, loadConfig, saveContentAtomically } from './config.js';
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

export async function installSiftKit(force?: boolean): Promise<Record<string, unknown>> {
  return withExecutionLock(async () => {
    void force;
    const paths = initializeRuntime();
    const config = await loadConfig({ ensure: true });
    const detectedOllamaExecutablePath = findOllamaExecutable();

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
      OllamaExecutablePath: detectedOllamaExecutablePath || config.Ollama.ExecutablePath,
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
