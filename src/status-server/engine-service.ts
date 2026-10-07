import { CommandOutputAnalyzer } from '../command-output/analyzer.ts';
import type {
  CommandOutputAnalyzeRequest,
  CommandOutputAnalyzeResult,
} from '../command-output/types.ts';
import { runEvaluation } from './eval.ts';
import type { EvalRequest, EvaluationResult } from '../eval-types.ts';
import { executeRepoSearchRequest } from '../repo-search/index.ts';
import type {
  RepoSearchExecutionRequest,
  RepoSearchExecutionResult,
} from '../repo-search/types.ts';
import { summarizeRequest } from '../summary/core.ts';
import type { SummaryRequest, SummaryResult } from '../summary/types.ts';
import type { SummaryProgressEvent } from '../summary/progress-reporter.ts';
import type { ProgressWriter } from '../lib/progress-writer.ts';
import type { SiftConfig } from '../config/types.ts';

export class StatusEngineService {
  private readonly commandOutputAnalyzer: CommandOutputAnalyzer;

  constructor(commandOutputAnalyzer: CommandOutputAnalyzer = new CommandOutputAnalyzer()) {
    this.commandOutputAnalyzer = commandOutputAnalyzer;
  }

  executeRepoSearch(request: RepoSearchExecutionRequest): Promise<RepoSearchExecutionResult> {
    return executeRepoSearchRequest(request);
  }

  summarize(request: SummaryRequest): Promise<SummaryResult> {
    return summarizeRequest(request);
  }

  analyzeCommandOutput(request: CommandOutputAnalyzeRequest): Promise<CommandOutputAnalyzeResult> {
    return this.commandOutputAnalyzer.analyze(request);
  }

  runEvaluation(
    request: EvalRequest,
    options: {
      progressWriter?: ProgressWriter<SummaryProgressEvent>;
      abortSignal?: AbortSignal;
      config?: SiftConfig;
    } = {},
  ): Promise<EvaluationResult> {
    return runEvaluation(request, options);
  }
}
