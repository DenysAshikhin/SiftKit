const { spawn } = require('node:child_process');
const http = require('node:http');
const net = require('node:net');

function startProcess(command, args, options = {}) {
  const child = spawn(command, args, {
    stdio: 'inherit',
    cwd: options.cwd || process.cwd(),
    env: options.env || process.env,
    shell: process.platform === 'win32',
  });
  child.on('error', (error) => {
    process.stderr.write(`[start-dev] Failed to start ${command}: ${error.message}\n`);
  });
  return child;
}

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
let statusProcess = null;
let dashboardProcess = null;

let shuttingDown = false;
function shutdown(signalName) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  for (const child of [statusProcess, dashboardProcess]) {
    if (child && !child.killed) {
      child.kill('SIGINT');
    }
  }
  setTimeout(() => {
    process.exit(signalName === 'SIGINT' ? 130 : 0);
  }, 150);
}

function waitForBackendReady(options = {}) {
  const host = process.env.SIFTKIT_STATUS_HOST || '127.0.0.1';
  const port = Number.parseInt(process.env.SIFTKIT_STATUS_PORT || '4765', 10);
  const timeoutMs = Number.isFinite(Number(options.timeoutMs)) ? Number(options.timeoutMs) : 30000;
  const pollMs = Number.isFinite(Number(options.pollMs)) ? Number(options.pollMs) : 400;
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const poll = () => {
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
  const statusHost = process.env.SIFTKIT_STATUS_HOST || '127.0.0.1';
  const statusPort = Number.parseInt(process.env.SIFTKIT_STATUS_PORT || '4765', 10);
  const portInUse = await new Promise((resolve) => {
    const socket = net.createConnection({ host: statusHost, port: statusPort });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => {
      resolve(false);
    });
    socket.setTimeout(1000, () => {
      socket.destroy();
      resolve(false);
    });
  });
  if (portInUse) {
    process.stderr.write(
      `[start-dev] Refusing to start because ${statusHost}:${statusPort} is already in use. `
      + 'Stop the existing status server process, then run npm start again.\n'
    );
    process.exit(1);
    return;
  }

  statusProcess = startProcess(npmCommand, ['run', 'start:status']);
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
