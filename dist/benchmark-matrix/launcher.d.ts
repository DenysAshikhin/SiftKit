import { type LaunchResult, type ResolvedMatrixManifest, type ResolvedMatrixTarget } from './types.js';
export declare function buildLaunchSignature(target: ResolvedMatrixTarget): string;
export declare function buildLauncherArgs(manifest: ResolvedMatrixManifest, target: ResolvedMatrixTarget): string[];
export declare function buildBenchmarkArgs(manifest: ResolvedMatrixManifest, run: ResolvedMatrixTarget, outputPath: string, promptPrefixFile: string | null): string[];
export declare function invokeStopScript(stopScriptPath: string): Promise<void>;
export declare function forceStopLlamaServer(sessionDirectory: string): Promise<void>;
export declare function startLlamaLauncher(manifest: ResolvedMatrixManifest, target: ResolvedMatrixTarget, sessionDirectory: string): Promise<LaunchResult>;
export declare function restartLlamaForTarget(manifest: ResolvedMatrixManifest, target: ResolvedMatrixTarget, sessionDirectory: string): Promise<void>;
