import { startStatusServer } from './index.js';

const server = startStatusServer({
  disableManagedLlamaStartup: process.argv.includes('--disable-managed-llama-startup'),
});
let shuttingDown = false;
let forcedExitTimer: NodeJS.Timeout | null = null;

async function shutdown(signal: string = 'SIGTERM'): Promise<void> {
  if (shuttingDown) {
    process.stderr.write('[siftKitStatus] Shutdown already in progress; forcing immediate exit.\n');
    server.shutdownManagedLlamaForProcessExitSync?.();
    process.exit(signal === 'SIGINT' ? 130 : 1);
  }
  shuttingDown = true;
  forcedExitTimer = setTimeout(() => {
    process.stderr.write('[siftKitStatus] Graceful shutdown timed out; forcing process exit.\n');
    server.shutdownManagedLlamaForProcessExitSync?.();
    process.exit(signal === 'SIGINT' ? 130 : 1);
  }, 15_000);
  forcedExitTimer.unref();
  try {
    await server.shutdownManagedLlamaForServerExit?.();
  } finally {
    if (forcedExitTimer !== null) {
      clearTimeout(forcedExitTimer);
      forcedExitTimer = null;
    }
    server.close(() => {
      if (signal === 'SIGUSR2') {
        process.kill(process.pid, 'SIGUSR2');
        return;
      }
      process.exit(0);
    });
  }
}

process.on('exit', () => { server.shutdownManagedLlamaForProcessExitSync?.(); });
process.on('SIGINT', () => { void shutdown('SIGINT'); });
process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
process.on('SIGUSR2', () => { void shutdown('SIGUSR2'); });
