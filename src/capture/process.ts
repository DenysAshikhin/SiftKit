import { spawnSync } from 'node:child_process';
import { findCommandInPath, resolveExternalCommand } from './command-path.js';

export type ShellName = 'auto' | 'pwsh' | 'powershell' | 'bash' | 'sh' | 'cmd';

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

type ShellResolution = {
  Executable: string;
  ArgumentPrefix: string[];
};

const SHELL_NAMES: ReadonlySet<ShellName> = new Set(['auto', 'pwsh', 'powershell', 'bash', 'sh', 'cmd']);

function resolveShell(shellName: ShellName): ShellResolution {
  if (!SHELL_NAMES.has(shellName)) {
    throw new Error(`Unsupported shell: ${shellName}`);
  }
  if (shellName === 'auto') {
    if (process.platform === 'win32') {
      const pwsh = findCommandInPath('pwsh') || findCommandInPath('powershell');
      if (pwsh) {
        return { Executable: pwsh, ArgumentPrefix: ['-NoProfile', '-NoLogo', '-NonInteractive', '-Command'] };
      }
      return { Executable: process.env.ComSpec || 'cmd.exe', ArgumentPrefix: ['/d', '/s', '/c'] };
    }
    const bash = findCommandInPath('bash');
    if (bash) {
      return { Executable: bash, ArgumentPrefix: ['-c'] };
    }
    return { Executable: '/bin/sh', ArgumentPrefix: ['-c'] };
  }
  if (shellName === 'pwsh' || shellName === 'powershell') {
    const executable = findCommandInPath(shellName) || shellName;
    return { Executable: executable, ArgumentPrefix: ['-NoProfile', '-NoLogo', '-NonInteractive', '-Command'] };
  }
  if (shellName === 'cmd') {
    return { Executable: process.env.ComSpec || 'cmd.exe', ArgumentPrefix: ['/d', '/s', '/c'] };
  }
  const executable = findCommandInPath(shellName) || shellName;
  return { Executable: executable, ArgumentPrefix: ['-c'] };
}

export function invokeShellProcess(script: string, shellName: ShellName): InvokeProcessResult {
  const resolution = resolveShell(shellName);
  const result = spawnSync(resolution.Executable, [...resolution.ArgumentPrefix, script], {
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    cwd: process.cwd(),
  });
  if (result.error) {
    const message = result.error.message || String(result.error);
    return { ExitCode: 1, StdOut: '', StdErr: message, Combined: message };
  }
  const stdout = result.stdout || '';
  const stderr = result.stderr || '';
  return {
    ExitCode: typeof result.status === 'number' ? result.status : 1,
    StdOut: stdout,
    StdErr: stderr,
    Combined: `${stdout}${stdout && stderr ? '\n' : ''}${stderr}`.trim(),
  };
}

export type TranscriptCaptureResult = {
  ExitCode: number;
  Transcript: string;
};

export function captureWithTranscript(
  commandPath: string,
  argumentList: string[],
): TranscriptCaptureResult {
  let result = spawnSync(commandPath, argumentList, {
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    cwd: process.cwd(),
  });
  if (result.error && /EPERM|EACCES/iu.test(result.error.message || '')) {
    result = spawnSync(commandPath, argumentList, {
      encoding: 'utf8',
      shell: true,
      windowsHide: true,
      cwd: process.cwd(),
    });
  }
  const stdout = result.stdout || '';
  const stderr = `${result.stderr || ''}${result.error ? `${result.stderr ? '\n' : ''}${result.error.message}` : ''}`;
  return {
    ExitCode: typeof result.status === 'number' ? result.status : 1,
    Transcript: `${stdout}${stdout && stderr ? '\n' : ''}${stderr}`.trim(),
  };
}
