import type { TemporaryTimingRecorder } from '../../lib/temporary-timing-recorder.ts';
import type { SiftConfig } from '../../config/index.ts';
import { estimateTokenCount } from '../../lib/token-estimate.ts';
import { countTokensWithFallbackDetailed } from '../prompt-budget.ts';
import { ToolOutputFitter, type ToolOutputTruncationUnit, type ToolOutputKeep } from '../../tool-output-fit.ts';
import { OUTPUT_TAIL_CAP_TOKENS, type AvailableToolResultCapacity } from './turn-budget.ts';

export type FittedToolResult = {
  resultText: string;
  resultTokenCount: number;
  resultTokenCountEstimated: boolean;
  fittedReturnedSegmentCount: number | null;
  rawResultTokenCount: number;
};

// A digest takes what it needs up to this share of the result, so the output tail behind it always keeps a third.
const DIGEST_MAX_SHARE = 2 / 3;

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
    /** The model asked for the raw output, so a digest does not cut a succeeded command's output to a tail. */
    fullOutputRequested: boolean;
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
    const fullOutput = options.commandSucceededForFitting && (options.digest === null || options.fullOutputRequested);
    const outputBudgetTokens = fullOutput ? successBudgetTokens : Math.min(OUTPUT_TAIL_CAP_TOKENS, successBudgetTokens);
    // The digest is short; counting it, not the raw output a second time, sizes both parts.
    const digestTokenCount = options.digest === null ? 0 : await this.countTokenValue(options.digest);

    if (candidateResultTokenCount > Math.min(successBudgetTokens, digestTokenCount + outputBudgetTokens)) {
      const budgeter = this;
      const fitter = new ToolOutputFitter({
        async countToolOutputTokens(text: string): Promise<number> {
          return budgeter.countTokenValue(text);
        },
      });
      // The digest leads whole within two thirds of the result; a longer one is cut from its end, so verdicts and failure names survive.
      const digestBudgetTokens = Math.max(1, Math.floor(successBudgetTokens * DIGEST_MAX_SHARE));
      let headerText = options.digest ?? undefined;
      let headerTokenCount = digestTokenCount;
      if (options.digest !== null && digestTokenCount > digestBudgetTokens) {
        headerText = (await fitter.fitSegments({
          segments: options.digest.split('\n'), separator: '\n', maxTokens: digestBudgetTokens, unit: 'lines', keep: 'head',
        })).visibleText;
        headerTokenCount = await this.countTokenValue(headerText);
      }
      const fitResult = await fitter.fitSegments({
        segments: options.resultText.split(/\r?\n/u).filter((line) => line.length > 0),
        separator: '\n',
        maxTokens: Math.max(1, Math.min(outputBudgetTokens, successBudgetTokens - headerTokenCount)),
        unit: options.outputUnit,
        keep: fullOutput ? options.keep : 'tail',
      });
      fittedReturnedSegmentCount = fitResult.returnedLineCount;
      resultText = headerText === undefined ? fitResult.visibleText : `${headerText}\n${fitResult.visibleText}`;
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
