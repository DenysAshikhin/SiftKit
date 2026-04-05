import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { ensureDirectory } from '../lib/fs.js';

export function spawnAndWait(options: {
  filePath: string;
  args: string[];
  cwd: string;
  stdoutPath: string;
  stderrPath: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{ exitCode: number; pid: number }> {
  return new Promise((resolve, reject) => {
    ensureDirectory(path.dirname(options.stdoutPath));
    ensureDirectory(path.dirname(options.stderrPath));
    const stdout = fs.openSync(options.stdoutPath, 'w');
    const stderr = fs.openSync(options.stderrPath, 'w');
    const child = spawn(options.filePath, options.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', stdout, stderr],
      windowsHide: true,
    });

    child.once('error', (error) => {
      fs.closeSync(stdout);
      fs.closeSync(stderr);
      reject(error);
    });

    child.once('exit', (code) => {
      fs.closeSync(stdout);
      fs.closeSync(stderr);
      resolve({
        exitCode: code ?? 0,
        pid: child.pid ?? 0,
      });
    });
  });
}
