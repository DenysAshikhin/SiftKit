'use strict';

// This file is a thin shim. The implementation lives in
// src/status-server/index.ts and is compiled to dist/status-server/index.js.
// Tests and the CLI still `require('../siftKitStatus/index.js')`, so we
// forward to the compiled TypeScript build.

const compiled = require('../dist/status-server/index.js');

module.exports = {
  buildIdleMetricsLogMessage: compiled.buildIdleMetricsLogMessage,
  buildRepoSearchProgressLogMessage: compiled.buildRepoSearchProgressLogMessage,
  buildIdleSummarySnapshot: compiled.buildIdleSummarySnapshot,
  buildStatusRequestLogMessage: compiled.buildStatusRequestLogMessage,
  colorize: compiled.colorize,
  formatElapsed: compiled.formatElapsed,
  getConfigPath: compiled.getConfigPath,
  getIdleSummarySnapshotsPath: compiled.getIdleSummarySnapshotsPath,
  getMetricsPath: compiled.getMetricsPath,
  getStatusPath: compiled.getStatusPath,
  terminateProcessTree: compiled.terminateProcessTree,
  supportsAnsiColor: compiled.supportsAnsiColor,
  startStatusServer: compiled.startStatusServer,
};

if (require.main === module) {
  const server = compiled.startStatusServer({
    disableManagedLlamaStartup: process.argv.includes('--disable-managed-llama-startup'),
  });
  let shuttingDown = false;
  let forcedExitTimer = null;
  const shutdown = async (signal = 'SIGTERM') => {
    if (shuttingDown) {
      process.stderr.write('[siftKitStatus] Shutdown already in progress; forcing immediate exit.\n');
      if (typeof server.shutdownManagedLlamaForProcessExitSync === 'function') {
        server.shutdownManagedLlamaForProcessExitSync();
      }
      process.exit(signal === 'SIGINT' ? 130 : 1);
      return;
    }
    shuttingDown = true;
    forcedExitTimer = setTimeout(() => {
      process.stderr.write('[siftKitStatus] Graceful shutdown timed out; forcing process exit.\n');
      if (typeof server.shutdownManagedLlamaForProcessExitSync === 'function') {
        server.shutdownManagedLlamaForProcessExitSync();
      }
      process.exit(signal === 'SIGINT' ? 130 : 1);
    }, 15000);
    if (typeof forcedExitTimer.unref === 'function') {
      forcedExitTimer.unref();
    }
    try {
      if (typeof server.shutdownManagedLlamaForServerExit === 'function') {
        await server.shutdownManagedLlamaForServerExit();
      }
    } finally {
      if (forcedExitTimer) {
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
  };
  process.on('exit', () => {
    if (typeof server.shutdownManagedLlamaForProcessExitSync === 'function') {
      server.shutdownManagedLlamaForProcessExitSync();
    }
  });
  process.on('SIGINT', () => { void shutdown('SIGINT'); });
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.on('SIGUSR2', () => { void shutdown('SIGUSR2'); });
}
