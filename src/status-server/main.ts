import { startStatusServer } from './index.js';
import { getErrorMessage } from '../lib/errors.js';
import { SHUTDOWN_FORCED_EXIT_TIMEOUT_MS } from './shutdown-budget.js';

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
  }, SHUTDOWN_FORCED_EXIT_TIMEOUT_MS);
  forcedExitTimer.unref();
  // server.close() stops the managed engine through the preset runtime coordinator before
  // releasing the listener, so the forced-exit timer stays armed until that callback runs.
  server.close((error?: Error) => {
    if (forcedExitTimer !== null) {
      clearTimeout(forcedExitTimer);
      forcedExitTimer = null;
    }
    // The callback runs only after the shutdown chain settled, and its argument is that chain's
    // rejection: a persistence stage that lost data arrives here. Reading it is the difference
    // between a reported failure and a green exit over zero saved rows.
    if (error) {
      process.stderr.write(`[siftKitStatus] Shutdown failed: ${getErrorMessage(error)}\n`);
    }
    if (signal === 'SIGUSR2') {
      process.kill(process.pid, 'SIGUSR2');
      return;
    }
    process.exit(error ? (signal === 'SIGINT' ? 130 : 1) : 0);
  });
}

process.on('exit', () => { server.shutdownEngineForProcessExitSync?.(); });
process.on('SIGINT', () => { shutdown('SIGINT'); });
process.on('SIGTERM', () => { shutdown('SIGTERM'); });
process.on('SIGUSR2', () => { shutdown('SIGUSR2'); });
