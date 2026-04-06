import { type MatrixCliOptions } from './types.js';
export declare function getRequiredString(value: unknown, name: string): string;
export declare function getRequiredInt(value: unknown, name: string): number;
export declare function getRequiredDouble(value: unknown, name: string): number;
export declare function getOptionalInt(value: unknown, name: string): number | null;
export declare function getOptionalPositiveInt(value: unknown, name: string): number | null;
export declare function getOptionalBoolean(value: unknown, name: string): boolean | null;
export declare function parseArguments(argv: string[]): MatrixCliOptions;
