import { CommandOutputAnalyzer } from '../command-output/analyzer.js';
import type {
  CommandOutputAnalyzeRequest,
  CommandOutputAnalyzeResult,
} from '../command-output/types.js';
import { runEvaluation } from './eval.js';
import type { EvalRequest, EvaluationResult } from '../eval-types.js';
import { executeRepoSearchRequest } from '../repo-search/index.js';
import type {
  RepoSearchExecutionRequest,
  RepoSearchExecutionResult,
} from '../repo-search/types.js';
import { summarizeRequest } from '../summary/core.js';
import type { SummaryRequest, SummaryResult } from '../summary/types.js';

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

  runEvaluation(request: EvalRequest): Promise<EvaluationResult> {
    return runEvaluation(request);
  }
}
