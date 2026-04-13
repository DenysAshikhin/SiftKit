import { spawn } from 'node:child_process';

export function spawnAndWait(options: {
  filePath: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  onStdoutChunk?: (chunk: string) => void;
  onStderrChunk?: (chunk: string) => void;
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

    child.once('error', (error) => {
      reject(error);
    });

    child.once('exit', (code) => {
      resolve({
        exitCode: code ?? 0,
        pid: child.pid ?? 0,
        stdout,
        stderr,
      });
    });
  });
}
