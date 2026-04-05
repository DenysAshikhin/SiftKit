import { formatElapsed } from '../lib/time.js';
import { BENCHMARK_HEARTBEAT_MS, FatalBenchmarkError } from './types.js';

export function createInterruptSignal(): {
  interrupted: Promise<never>;
  dispose: () => void;
} {
  let rejectInterrupted: (reason?: unknown) => void = () => {};
  const interrupted = new Promise<never>((_resolve, reject) => {
    rejectInterrupted = reject;
  });
  let active = true;
  const onSignal = (signal: NodeJS.Signals): void => {
    if (!active) {
      return;
    }
    active = false;
    rejectInterrupted(new FatalBenchmarkError(`Benchmark interrupted by ${signal}.`));
  };

  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  return {
    interrupted,
    dispose: () => {
      active = false;
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
    },
  };
}

export function createFixtureHeartbeat(options: {
  fixtureLabel: string;
  fixtureIndex: number;
  fixtureCount: number;
  startedAtMs: number;
}): NodeJS.Timeout {
  const handle = setInterval(() => {
    const elapsedMs = Date.now() - options.startedAtMs;
    process.stdout.write(
      `Fixture ${options.fixtureIndex}/${options.fixtureCount} [${options.fixtureLabel}] still running after ${formatElapsed(elapsedMs)}\n`
    );
  }, BENCHMARK_HEARTBEAT_MS);
  if (typeof handle.unref === 'function') {
    handle.unref();
  }

  return handle;
}

export async function runWithFixtureDeadline<T>(
  operation: Promise<T>,
  options: {
    fixtureLabel: string;
    requestTimeoutSeconds: number;
    interrupted: Promise<never>;
  },
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeoutHandle = setTimeout(() => {
      reject(new FatalBenchmarkError(
        `Benchmark fixture '${options.fixtureLabel}' timed out after ${options.requestTimeoutSeconds} seconds.`
      ));
    }, options.requestTimeoutSeconds * 1000);
    if (typeof timeoutHandle.unref === 'function') {
      timeoutHandle.unref();
    }

    const resolveOnce = (value: T): void => {
      clearTimeout(timeoutHandle);
      resolve(value);
    };
    const rejectOnce = (error: unknown): void => {
      clearTimeout(timeoutHandle);
      reject(error);
    };

    operation.then(
      (value) => resolveOnce(value),
      (error) => rejectOnce(error),
    );
    options.interrupted.then(
      () => undefined,
      (error) => rejectOnce(error),
    );
  });
}

export function isTimeoutError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\btimed out after\b/iu.test(message);
}
