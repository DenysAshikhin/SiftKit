import type { TemporaryTimingRecorder } from '../../lib/temporary-timing-recorder.js';
import type { SiftConfig } from '../../config/index.js';
import { estimateTokenCount } from '../../lib/token-estimate.js';
import { countTokensWithFallbackDetailed } from '../prompt-budget.js';
import { ToolOutputFitter, type ToolOutputTruncationUnit, type ToolOutputKeep } from '../../tool-output-fit.js';

// A failing command's tail is still evidence — test runners and compilers print
// their verdicts and failure summaries last — but failure dumps are low-density,
// so the kept tail gets a small fixed budget instead of the growing per-tool cap.
// ~75-125 lines: enough for a runner summary plus failing-test names, never
// enough for repeated failures to starve the remaining allowance.
export const FAILED_COMMAND_TAIL_CAP_TOKENS = 1_024;

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

    const successBudgetTokens = Math.min(options.perToolCapTokens, Math.max(1, options.remainingTokenAllowance));
    const maxResultTokens = options.commandSucceededForFitting
      ? successBudgetTokens
      : Math.min(FAILED_COMMAND_TAIL_CAP_TOKENS, successBudgetTokens);

    if (candidateResultTokenCount > maxResultTokens) {
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
