import { spawnSync } from 'node:child_process';
import { spawnPowerShellSync } from '../lib/powershell.js';
import { resolveExternalCommand } from './command-path.js';

export type InvokeProcessResult = {
  ExitCode: number;
  StdOut: string;
  StdErr: string;
  Combined: string;
};

export function invokeProcess(command: string, argumentList: string[] = []): InvokeProcessResult {
  const runChild = (executable: string, shell: boolean) => spawnSync(executable, argumentList, {
    encoding: 'utf8',
    shell,
    windowsHide: true,
    cwd: process.cwd(),
  });
  let result = runChild(command, false);
  if (result.error && /ENOENT/iu.test(result.error.message || '')) {
    try {
      result = runChild(resolveExternalCommand(command), false);
    } catch (error) {
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

export function quoteForPowerShell(value: string): string {
  return `'${value.replace(/'/gu, "''")}'`;
}

export function captureWithTranscript(
  commandPath: string,
  argumentList: string[],
  transcriptPath: string,
): number {
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

  const result = spawnPowerShellSync(script, {
    stdio: 'ignore',
    windowsHide: false,
  });
  return typeof result.status === 'number' ? result.status : 1;
}
