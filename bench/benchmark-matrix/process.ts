import { spawn } from 'node:child_process';

export function spawnAndWait(options: {
  filePath: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  onStdoutChunk?: (chunk: string) => void;
  onStderrChunk?: (chunk: string) => void;
  interrupted?: Promise<never>;
}): Promise<{ exitCode: number; pid: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(options.filePath, options.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const settle = (action: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      action();
    };
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string | Buffer) => {
      const next = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      stdout = `${stdout}${next}`;
      options.onStdoutChunk?.(next);
    });
    child.stderr?.on('data', (chunk: string | Buffer) => {
      const next = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      stderr = `${stderr}${next}`;
      options.onStderrChunk?.(next);
    });

    // An interrupted matrix must not leave the spawned process running; kill it
    // and reject so callers stop awaiting a child that will never finish.
    options.interrupted?.catch((error: unknown) => {
      child.kill();
      settle(() => reject(error));
    });

    child.once('error', (error) => {
      settle(() => reject(error));
    });

    child.once('exit', (code) => {
      settle(() => resolve({
        exitCode: code ?? 0,
        pid: child.pid ?? 0,
        stdout,
        stderr,
      }));
    });
  });
}
