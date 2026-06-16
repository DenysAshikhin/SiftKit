import { MatrixInterruptedError } from './types.js';

export function createMatrixInterruptSignal(
  onInterrupt: (error: MatrixInterruptedError) => void,
): {
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
    const error = new MatrixInterruptedError(signal);
    onInterrupt(error);
    rejectInterrupted(error);
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

export async function withMatrixInterrupt<T>(
  operation: Promise<T>,
  interrupted: Promise<never>,
): Promise<T> {
  return Promise.race([operation, interrupted]);
}
