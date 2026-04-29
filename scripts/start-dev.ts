import { spawn, type ChildProcess } from 'node:child_process';
import * as http from 'node:http';

import { buildStartupPortChecks, isPortInUse } from './start-dev-ports.js';
import { stopChildProcessTree } from './start-dev-process.js';

type SpawnOptions = { cwd?: string; env?: NodeJS.ProcessEnv };

function startProcess(command: string, args: string[], options: SpawnOptions = {}): ChildProcess {
  // On Windows, .cmd/.bat files can't be spawned directly without a shell. Avoid
  // `shell: true` (which triggers Node DEP0190) by wrapping with `cmd.exe /d /s /c`.
  const isWindowsCmd = process.platform === 'win32' && /\.(cmd|bat)$/iu.test(command);
  const spawnCommand = isWindowsCmd ? 'cmd.exe' : command;
  const spawnArgs = isWindowsCmd ? ['/d', '/s', '/c', command, ...args] : args;
  const child = spawn(spawnCommand, spawnArgs, {
    stdio: 'inherit',
    cwd: options.cwd || process.cwd(),
    env: options.env || process.env,
    windowsHide: true,
  });
  child.on('error', (error: Error) => {
    process.stderr.write(`[start-dev] Failed to start ${command}: ${error.message}\n`);
  });
  return child;
}

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const useStableStatus = process.argv.includes('--stable');
const statusScript = useStableStatus ? 'start:status:stable:server' : 'start:status';
let statusProcess: ChildProcess | null = null;
let dashboardProcess: ChildProcess | null = null;
let reuseExistingDashboard = false;

let shuttingDown = false;
function shutdown(signalName: string): void {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  for (const child of [statusProcess, dashboardProcess]) {
    stopChildProcessTree(child);
  }
  setTimeout(() => {
    process.exit(signalName === 'SIGINT' ? 130 : 0);
  }, 150);
}

function waitForBackendReady(options: { timeoutMs?: number; pollMs?: number } = {}): Promise<boolean> {
  const host = process.env.SIFTKIT_STATUS_HOST || '127.0.0.1';
  const port = Number.parseInt(process.env.SIFTKIT_STATUS_PORT || '4765', 10);
  const timeoutMs = Number.isFinite(Number(options.timeoutMs)) ? Number(options.timeoutMs) : 30000;
  const pollMs = Number.isFinite(Number(options.pollMs)) ? Number(options.pollMs) : 400;
  const deadline = Date.now() + timeoutMs;
  return new Promise<boolean>((resolve) => {
    const poll = (): void => {
      if (shuttingDown) {
        resolve(false);
        return;
      }
      const request = http.request(
        {
          protocol: 'http:',
          hostname: host,
          port,
          path: '/health',
          method: 'GET',
          timeout: 1200,
        },
        (response) => {
          response.resume();
          if (response.statusCode && response.statusCode >= 200 && response.statusCode < 500) {
            resolve(true);
            return;
          }
          if (Date.now() >= deadline) {
            resolve(false);
            return;
          }
          setTimeout(poll, pollMs);
        }
      );
      request.on('error', () => {
        if (Date.now() >= deadline) {
          resolve(false);
          return;
        }
        setTimeout(poll, pollMs);
      });
      request.on('timeout', () => {
        request.destroy(new Error('health timeout'));
      });
      request.end();
    };
    poll();
  });
}

void (async () => {
  for (const portCheck of buildStartupPortChecks(process.env)) {
    if (await isPortInUse(portCheck.host, portCheck.port)) {
      if (portCheck.fatalIfInUse) {
        process.stderr.write(
          `[start-dev] Refusing to start because ${portCheck.name} port ${portCheck.host}:${portCheck.port} is already in use. `
          + 'Stop the existing process, then run npm start again.\n'
        );
        process.exit(1);
        return;
      }
      if (portCheck.service === 'dashboard') {
        reuseExistingDashboard = true;
        process.stderr.write(
          `[start-dev] Dashboard port ${portCheck.host}:${portCheck.port} is already in use; reusing the existing dashboard.\n`
        );
      }
    }
  }

  statusProcess = startProcess(npmCommand, ['run', statusScript]);
  statusProcess.on('exit', (code) => {
    if (!shuttingDown) {
      process.stderr.write(`[start-dev] Status server exited with code ${code ?? 0}; stopping dashboard.\n`);
      shutdown('SIGTERM');
    }
  });

  const ready = await waitForBackendReady({ timeoutMs: 45000, pollMs: 500 });
  if (!ready) {
    process.stderr.write('[start-dev] Backend health was not reachable in time; starting dashboard anyway.\n');
  }
  if (shuttingDown) {
    return;
  }
  if (reuseExistingDashboard) {
    return;
  }
  dashboardProcess = startProcess(npmCommand, ['run', 'start:dashboard']);
  dashboardProcess.on('exit', (code) => {
    if (!shuttingDown) {
      process.stderr.write(`[start-dev] Dashboard exited with code ${code ?? 0}; stopping status server.\n`);
      shutdown('SIGTERM');
    }
  });
})();

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
