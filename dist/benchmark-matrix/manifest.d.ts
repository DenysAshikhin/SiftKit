import { type MatrixCliOptions, type ResolvedMatrixManifest, type ResolvedMatrixTarget } from './types.js';
export declare function readTrimmedFileText(filePath: string): string;
export declare function resolveModelPathForStartScript(modelPath: string, startScriptPath: string): string;
export declare function getSelectedRuns(enabledRuns: ResolvedMatrixTarget[], requestedRunIds: string[]): ResolvedMatrixTarget[];
export declare function readMatrixManifest(options: MatrixCliOptions): ResolvedMatrixManifest;
