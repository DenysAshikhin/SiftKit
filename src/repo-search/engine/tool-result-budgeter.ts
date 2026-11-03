import type { TemporaryTimingRecorder } from '../../lib/temporary-timing-recorder.ts';
import type { SiftConfig } from '../../config/index.ts';
import { estimateTokenCount } from '../../lib/token-estimate.ts';
import { countTokensWithFallbackDetailed } from '../prompt-budget.ts';
import { ToolOutputFitter, type ToolOutputTruncationUnit, type ToolOutputKeep } from '../../tool-output-fit.ts';
import { FAILED_COMMAND_TAIL_CAP_TOKENS, type AvailableToolResultCapacity } from './turn-budget.ts';

export type FittedToolResult = {
  resultText: string;
  resultTokenCount: number;
  resultTokenCountEstimated: boolean;
  fittedReturnedSegmentCount: number | null;
  rawResultTokenCount: number;
};

// A truncated result keeps half its budget, so a digest within a third leaves the tail at least a sixth.
const DIGEST_BUDGET_SHARE = 1 / 3;

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
    /** Resolved before the tool ran; zero capacity never reaches the budgeter. */
    capacity: AvailableToolResultCapacity;
    commandSucceededForFitting: boolean;
    outputUnit: ToolOutputTruncationUnit;
    keep: ToolOutputKeep;
    /** A rendered digest of the whole command output, which leads the result; null when no parser recognised it. */
    digest: string | null;
  }): Promise<FittedToolResult> {
    const rawToolTokenSpan = this.timingRecorder?.start('repo.tool.tokenize_raw', {
      taskId: options.taskId, turn: options.turn, toolName: options.toolName, inputChars: options.rawResultText.length,
    });
    const rawResultTokenResult = await this.countTokens(options.rawResultText);
    const rawResultTokenCount = rawResultTokenResult.tokenCount;
    rawToolTokenSpan?.end({ tokenCount: rawResultTokenCount });

    const candidateText = options.digest === null ? options.resultText : `${options.digest}\n${options.resultText}`;
    const promptToolTokenSpan = this.timingRecorder?.start('repo.tool.tokenize_prompt', {
      taskId: options.taskId, turn: options.turn, toolName: options.toolName, inputChars: candidateText.length,
    });
    const candidateResultTokenResult = await this.countTokens(candidateText);
    const candidateResultTokenCount = candidateResultTokenResult.tokenCount;
    promptToolTokenSpan?.end({ tokenCount: candidateResultTokenCount });

    let resultText = candidateText;
    let resultTokenCount = candidateResultTokenCount;
    let resultTokenCountEstimated = candidateResultTokenResult.estimated;
    let fittedReturnedSegmentCount: number | null = null;

    const successBudgetTokens = Math.min(options.capacity.perToolCapTokens, options.capacity.remainingTokenAllowance);
    const maxResultTokens = options.commandSucceededForFitting
      ? successBudgetTokens
      : Math.min(FAILED_COMMAND_TAIL_CAP_TOKENS, successBudgetTokens);

    if (candidateResultTokenCount > maxResultTokens) {
      const segments = options.resultText.split(/\r?\n/u).filter((line) => line.length > 0);
      const budgeter = this;
      const fitter = new ToolOutputFitter({
        async countToolOutputTokens(text: string): Promise<number> {
          return budgeter.countTokenValue(text);
        },
      });
      // The digest is cut from its end so every verdict and failure name survives first.
      const headerText = options.digest === null ? undefined : (await fitter.fitSegments({
        segments: options.digest.split('\n'), separator: '\n', maxTokens: maxResultTokens * DIGEST_BUDGET_SHARE, unit: 'lines', keep: 'head',
      })).visibleText;
      const fitResult = await fitter.fitSegments({
        headerText,
        segments,
        separator: '\n',
        maxTokens: maxResultTokens,
        unit: options.outputUnit,
        keep: options.commandSucceededForFitting ? options.keep : 'tail',
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
    }

    return { resultText, resultTokenCount, resultTokenCountEstimated, fittedReturnedSegmentCount, rawResultTokenCount };
  }
}
