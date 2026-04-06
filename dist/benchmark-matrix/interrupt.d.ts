import { MatrixInterruptedError } from './types.js';
export declare function createMatrixInterruptSignal(onInterrupt: (error: MatrixInterruptedError) => void): {
    interrupted: Promise<never>;
    dispose: () => void;
};
export declare function withMatrixInterrupt<T>(operation: Promise<T>, interrupted: Promise<never>): Promise<T>;
