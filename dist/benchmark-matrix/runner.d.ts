import { type MatrixCliOptions } from './types.js';
export declare function runMatrixWithInterrupt(options: MatrixCliOptions, interruptSignalOverride?: {
    interrupted: Promise<never>;
    dispose: () => void;
}): Promise<void>;
export declare function runMatrix(options: MatrixCliOptions): Promise<void>;
export declare function main(): Promise<void>;
