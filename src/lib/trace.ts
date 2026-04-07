/**
 * Shared trace-logging factory.  Each subsystem creates its own tracer bound
 * to an environment variable and label; the tracer is a no-op when the env
 * var is not set to '1'.
 */

export function createTracer(envVar: string, label: string): (message: string) => void {
  return (message: string): void => {
    if (process.env[envVar] !== '1') return;
    process.stderr.write(`[siftkit-trace ${new Date().toISOString()}] ${label} ${message}\n`);
  };
}
