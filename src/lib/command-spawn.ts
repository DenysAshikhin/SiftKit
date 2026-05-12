import { spawn } from 'node:child_process';

export type DirectCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  output: string;
};

export type DirectCommandOptions = {
  cwd?: string;
  windowsHide?: boolean;
  abortSignal?: AbortSignal;
};

export function spawnDirectCommand(
  command: string,
  args: string[],
  options: DirectCommandOptions = {},
): Promise<DirectCommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      windowsHide: options.windowsHide ?? true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let spawnError: (Error & { code?: string }) | null = null;

    const abort = (): void => {
      child.kill();
    };
    const cleanup = (): void => {
      options.abortSignal?.removeEventListener('abort', abort);
    };

    if (options.abortSignal?.aborted) {
      child.kill();
    } else {
      options.abortSignal?.addEventListener('abort', abort, { once: true });
    }

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', (error: Error & { code?: string }) => { spawnError = error; });
    child.on('close', (code) => {
      cleanup();
      const outputParts: string[] = [];
      if (spawnError) {
        const errorCode = typeof spawnError.code === 'string' ? spawnError.code : 'unknown';
        outputParts.push(`spawn_error=${errorCode} message=${spawnError.message}`);
      }
      const textOutput = `${stdout}${stderr}`.trim();
      if (textOutput) outputParts.push(textOutput);
      resolve({
        exitCode: typeof code === 'number' ? code : (spawnError ? 126 : 1),
        stdout,
        stderr,
        output: outputParts.join('\n').trim(),
      });
    });
  });
}
