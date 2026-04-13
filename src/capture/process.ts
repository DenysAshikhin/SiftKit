import { spawnSync } from 'node:child_process';
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
