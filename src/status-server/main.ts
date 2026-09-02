import { startStatusServer } from './index.js';

const server = startStatusServer({
  disableManagedEngineStartup: process.argv.includes('--disable-managed-engine-startup'),
});
let shuttingDown = false;
let forcedExitTimer: NodeJS.Timeout | null = null;

function shutdown(signal: string = 'SIGTERM'): void {
  if (shuttingDown) {
    process.stderr.write('[siftKitStatus] Shutdown already in progress; forcing immediate exit.\n');
    server.shutdownEngineForProcessExitSync?.();
    process.exit(signal === 'SIGINT' ? 130 : 1);
  }
  shuttingDown = true;
  forcedExitTimer = setTimeout(() => {
    process.stderr.write('[siftKitStatus] Graceful shutdown timed out; forcing process exit.\n');
    server.shutdownEngineForProcessExitSync?.();
    process.exit(signal === 'SIGINT' ? 130 : 1);
  }, 15_000);
  forcedExitTimer.unref();
  // server.close() stops the managed engine through the preset runtime coordinator before
  // releasing the listener, so the forced-exit timer stays armed until that callback runs.
  server.close(() => {
    if (forcedExitTimer !== null) {
      clearTimeout(forcedExitTimer);
      forcedExitTimer = null;
    }
    if (signal === 'SIGUSR2') {
      process.kill(process.pid, 'SIGUSR2');
      return;
    }
    process.exit(0);
  });
}

process.on('exit', () => { server.shutdownEngineForProcessExitSync?.(); });
process.on('SIGINT', () => { shutdown('SIGINT'); });
process.on('SIGTERM', () => { shutdown('SIGTERM'); });
process.on('SIGUSR2', () => { shutdown('SIGUSR2'); });
