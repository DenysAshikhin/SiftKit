import type { OrchestratorVerificationCheck } from '@siftkit/contracts';

import { parseJsonValueText } from '../lib/json.ts';
import { RUN_SHELL_LABEL, spawnPowerShellAsync } from '../lib/powershell.ts';
import { z } from '../lib/zod.ts';

const PREFLIGHT_MARKER = 'SIFTKIT_CHECK_PREFLIGHT:';
const PREFLIGHT_TIMEOUT_MS = 30_000;
const PreflightProblemsSchema = z.array(z.object({ command: z.string(), problem: z.string() }));

// Parses each command with the PowerShell parser and resolves every named command; path-like names are left to the run.
const PREFLIGHT_SCRIPT = String.raw`
$commands = (@($input) -join [Environment]::NewLine) | ConvertFrom-Json
$problems = @()
foreach ($command in @($commands)) {
  $tokens = $null; $errors = $null
  $ast = [System.Management.Automation.Language.Parser]::ParseInput($command, [ref]$tokens, [ref]$errors)
  if ($errors.Count -gt 0) {
    $problems += [pscustomobject]@{ command = $command; problem = "does not parse as PowerShell: $($errors[0].Message)" }
    continue
  }
  $names = @($ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.CommandAst] }, $true) |
    ForEach-Object { $_.GetCommandName() } | Where-Object { $_ -and $_ -notmatch '[\\/]' })
  foreach ($name in $names) {
    if (-not (Get-Command -Name $name -ErrorAction SilentlyContinue)) {
      $problems += [pscustomobject]@{ command = $command; problem = "'$name' is not a PowerShell command or a program on PATH" }
    }
  }
}
Write-Output ('${PREFLIGHT_MARKER}' + (ConvertTo-Json -Compress -InputObject @($problems)))
`;

/** Why declared command checks cannot run in the check shell: a parse error or an unresolvable command name. */
export async function findUnrunnableChecks(repoRoot: string, checks: readonly OrchestratorVerificationCheck[],
  abortSignal: AbortSignal): Promise<string[]> {
  const commands = [...new Set(checks.flatMap((check) => (check.kind === 'command' ? [check.command] : [])))];
  if (commands.length === 0) return [];
  const result = await spawnPowerShellAsync(PREFLIGHT_SCRIPT, { cwd: repoRoot, abortSignal, timeoutMs: PREFLIGHT_TIMEOUT_MS,
    stdinData: JSON.stringify(commands) });
  abortSignal.throwIfAborted();
  const line = result.output.split(/\r?\n/u).find((entry) => entry.startsWith(PREFLIGHT_MARKER));
  if (line === undefined) throw new Error(`The check preflight produced no result (exit ${result.exitCode}): ${result.output.slice(-2_000)}`);
  return PreflightProblemsSchema.parse(parseJsonValueText(line.slice(PREFLIGHT_MARKER.length)))
    .map(({ command, problem }) => `Check \`${command}\` cannot run in ${RUN_SHELL_LABEL}: ${problem}.`);
}
