import { colorize } from '../../lib/text-format.js';
import type { TemporaryTimingRecorder } from '../../lib/temporary-timing-recorder.js';
import type { SiftConfig } from '../../config/index.js';
import { countTokensWithFallbackDetailed, estimateTokenCount } from '../prompt-budget.js';
import { ToolOutputFitter, type ToolOutputTruncationUnit, type ToolOutputKeep } from '../../tool-output-fit.js';

const ANSI_RED_CODE = 31;

function writeRedConsoleLine(message: string): void {
  if (!message) return;
  process.stderr.write(`${colorize(String(message), ANSI_RED_CODE, { isTTY: true })}\n`);
}

export type FittedToolResult = {
  resultText: string;
  resultTokenCount: number;
  resultTokenCountEstimated: boolean;
  fittedReturnedSegmentCount: number | null;
  rawResultTokenCount: number;
};

type CountedTokenResult = {
  tokenCount: number;
  estimated: boolean;
};

export class ToolResultBudgeter {
  private readonly config: SiftConfig | undefined;
  private readonly useEstimatedTokensOnly: boolean;
  private readonly timingRecorder: TemporaryTimingRecorder | null;

  constructor(options: {
    config: SiftConfig | undefined;
    useEstimatedTokensOnly: boolean;
    timingRecorder: TemporaryTimingRecorder | null;
  }) {
    this.config = options.config;
    this.useEstimatedTokensOnly = options.useEstimatedTokensOnly;
    this.timingRecorder = options.timingRecorder;
  }

  private async countTokens(text: string): Promise<CountedTokenResult> {
    if (this.useEstimatedTokensOnly) {
      return { tokenCount: estimateTokenCount(this.config, text), estimated: true };
    }
    const result = await countTokensWithFallbackDetailed(this.config, text);
    return { tokenCount: result.tokenCount, estimated: result.source === 'estimate' };
  }

  private async countTokenValue(text: string): Promise<number> {
    return (await this.countTokens(text)).tokenCount;
  }

  async fit(options: {
    taskId: string;
    turn: number;
    toolName: string;
    resultText: string;
    rawResultText: string;
    perToolCapTokens: number;
    remainingTokenAllowance: number;
    commandSucceededForFitting: boolean;
    outputUnit: ToolOutputTruncationUnit;
    keep: ToolOutputKeep;
  }): Promise<FittedToolResult> {
    const rawToolTokenSpan = this.timingRecorder?.start('repo.tool.tokenize_raw', {
      taskId: options.taskId, turn: options.turn, toolName: options.toolName, inputChars: options.rawResultText.length,
    });
    const rawResultTokenResult = await this.countTokens(options.rawResultText);
    const rawResultTokenCount = rawResultTokenResult.tokenCount;
    rawToolTokenSpan?.end({ tokenCount: rawResultTokenCount });

    const promptToolTokenSpan = this.timingRecorder?.start('repo.tool.tokenize_prompt', {
      taskId: options.taskId, turn: options.turn, toolName: options.toolName, inputChars: options.resultText.length,
    });
    const candidateResultTokenResult = await this.countTokens(options.resultText);
    const candidateResultTokenCount = candidateResultTokenResult.tokenCount;
    promptToolTokenSpan?.end({ tokenCount: candidateResultTokenCount });

    let resultText = options.resultText;
    let resultTokenCount = candidateResultTokenCount;
    let resultTokenCountEstimated = candidateResultTokenResult.estimated;
    let fittedReturnedSegmentCount: number | null = null;

    if (candidateResultTokenCount > options.perToolCapTokens || candidateResultTokenCount > options.remainingTokenAllowance) {
      if (options.commandSucceededForFitting) {
        const segments = resultText.split(/\r?\n/u).filter((line) => line.length > 0);
        const budgeter = this;
        const fitter = new ToolOutputFitter({
          async countToolOutputTokens(text: string): Promise<number> {
            return budgeter.countTokenValue(text);
          },
        });
        const fitResult = await fitter.fitSegments({
          headerText: undefined,
          segments,
          separator: '\n',
          maxTokens: Math.min(options.perToolCapTokens, Math.max(1, options.remainingTokenAllowance)),
          unit: options.outputUnit,
          keep: options.keep,
        });
        fittedReturnedSegmentCount = fitResult.returnedLineCount;
        resultText = fitResult.visibleText;
        const fitTokenSpan = this.timingRecorder?.start('repo.tool.tokenize_fit', {
          taskId: options.taskId, turn: options.turn, toolName: options.toolName, inputChars: resultText.length,
        });
        const resultTokenResult = await this.countTokens(resultText);
        resultTokenCount = resultTokenResult.tokenCount;
        fitTokenSpan?.end({ tokenCount: resultTokenCount });
        resultTokenCountEstimated = resultTokenResult.estimated;
      } else {
        resultText = `Error: requested output would consume ${candidateResultTokenCount} tokens, remaining token allowance: ${options.remainingTokenAllowance}, per tool call allowance: ${options.perToolCapTokens}`;
        writeRedConsoleLine(`repo_search warning: ${resultText}`);
        const rejectionToolTokenSpan = this.useEstimatedTokensOnly
          ? null
          : this.timingRecorder?.start('repo.tool.tokenize_rejection', {
            taskId: options.taskId, turn: options.turn, toolName: options.toolName, inputChars: resultText.length,
          });
        const resultTokenResult = await this.countTokens(resultText);
        resultTokenCount = resultTokenResult.tokenCount;
        rejectionToolTokenSpan?.end({ tokenCount: resultTokenCount });
        resultTokenCountEstimated = resultTokenResult.estimated;
      }
    }

    return { resultText, resultTokenCount, resultTokenCountEstimated, fittedReturnedSegmentCount, rawResultTokenCount };
  }
}
