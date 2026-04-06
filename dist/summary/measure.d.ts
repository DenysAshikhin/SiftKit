import type { QuestionAnalysis } from './types.js';
export declare const UNSUPPORTED_INPUT_MESSAGE = "The command/input is either unsupported or failed. Please verify the command that it is supported in the current environment and returns proper input. If it does, raise an explicit error to the user and stop futher processing.";
export declare function normalizeInputText(text: string | null | undefined): string | null;
export declare function measureText(text: string): {
    CharacterCount: number;
    LineCount: number;
};
export declare function getQuestionAnalysis(question: string | null | undefined): QuestionAnalysis;
export type ErrorSignalMetrics = {
    NonEmptyLineCount: number;
    ErrorLineCount: number;
    ErrorRatio: number;
};
export declare function getErrorSignalMetrics(text: string): ErrorSignalMetrics;
export declare function isPassFailQuestion(question: string | null | undefined): boolean;
export declare function getDeterministicExcerpt(text: string | null | undefined, question: string | null | undefined): string | null;
