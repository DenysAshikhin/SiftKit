import { colorize } from '../../lib/text-format.js';
import type { TemporaryTimingRecorder } from '../../lib/temporary-timing-recorder.js';
import type { SiftConfig } from '../../config/index.js';
import { countTokensWithFallback, estimateTokenCount } from '../prompt-budget.js';
import { ToolOutputFitter, type ToolOutputTruncationUnit } from '../../tool-output-fit.js';

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

  private async countTokens(text: string): Promise<number> {
    return this.useEstimatedTokensOnly
      ? estimateTokenCount(this.config, text)
      : await countTokensWithFallback(this.config, text);
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
  }): Promise<FittedToolResult> {
    const rawToolTokenSpan = this.timingRecorder?.start('repo.tool.tokenize_raw', {
      taskId: options.taskId, turn: options.turn, toolName: options.toolName, inputChars: options.rawResultText.length,
    });
    const rawResultTokenCount = await this.countTokens(options.rawResultText);
    rawToolTokenSpan?.end({ tokenCount: rawResultTokenCount });

    const promptToolTokenSpan = this.timingRecorder?.start('repo.tool.tokenize_prompt', {
      taskId: options.taskId, turn: options.turn, toolName: options.toolName, inputChars: options.resultText.length,
    });
    const candidateResultTokenCount = await this.countTokens(options.resultText);
    promptToolTokenSpan?.end({ tokenCount: candidateResultTokenCount });

    let resultText = options.resultText;
    let resultTokenCount = candidateResultTokenCount;
    let resultTokenCountEstimated = this.useEstimatedTokensOnly;
    let fittedReturnedSegmentCount: number | null = null;

    if (candidateResultTokenCount > options.perToolCapTokens || candidateResultTokenCount > options.remainingTokenAllowance) {
      if (options.commandSucceededForFitting) {
        const segments = resultText.split(/\r?\n/u).filter((line) => line.length > 0);
        const budgeter = this;
        const fitter = new ToolOutputFitter({
          async countToolOutputTokens(text: string): Promise<number> {
            return budgeter.countTokens(text);
          },
        });
        const fitResult = await fitter.fitSegments({
          headerText: undefined,
          segments,
          separator: '\n',
          maxTokens: Math.min(options.perToolCapTokens, Math.max(1, options.remainingTokenAllowance)),
          unit: options.outputUnit,
        });
        fittedReturnedSegmentCount = fitResult.returnedLineCount;
        resultText = fitResult.visibleText;
        const fitTokenSpan = this.timingRecorder?.start('repo.tool.tokenize_fit', {
          taskId: options.taskId, turn: options.turn, toolName: options.toolName, inputChars: resultText.length,
        });
        resultTokenCount = await this.countTokens(resultText);
        fitTokenSpan?.end({ tokenCount: resultTokenCount });
        resultTokenCountEstimated = this.useEstimatedTokensOnly;
      } else {
        resultText = `Error: requested output would consume ${candidateResultTokenCount} tokens, remaining token allowance: ${options.remainingTokenAllowance}, per tool call allowance: ${options.perToolCapTokens}`;
        writeRedConsoleLine(`repo_search warning: ${resultText}`);
        const rejectionToolTokenSpan = this.useEstimatedTokensOnly
          ? null
          : this.timingRecorder?.start('repo.tool.tokenize_rejection', {
            taskId: options.taskId, turn: options.turn, toolName: options.toolName, inputChars: resultText.length,
          });
        resultTokenCount = await this.countTokens(resultText);
        rejectionToolTokenSpan?.end({ tokenCount: resultTokenCount });
        resultTokenCountEstimated = this.useEstimatedTokensOnly;
      }
    }

    return { resultText, resultTokenCount, resultTokenCountEstimated, fittedReturnedSegmentCount, rawResultTokenCount };
  }
}
