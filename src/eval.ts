import * as fs from 'node:fs';
import * as path from 'node:path';
import { getConfiguredModel, initializeRuntime, loadConfig, saveContentAtomically } from './config.js';
import { summarizeRequest } from './summary.js';
import { withExecutionLock } from './execution-lock.js';
import { newArtifactPath } from './capture/artifacts.js';

export type EvalRequest = {
  FixtureRoot?: string;
  RealLogPath?: string[];
  Backend?: string;
  Model?: string;
};

type Fixture = {
  Name: string;
  File: string;
  Question: string;
  Format: 'text' | 'json';
  PolicyProfile: 'general' | 'pass-fail' | 'unique-errors' | 'buried-critical' | 'json-extraction' | 'diff-summary' | 'risky-operation';
  RequiredTerms?: string[];
  ForbiddenTerms?: string[];
};

function getRepoRoot(): string {
  return path.resolve(__dirname, '..', '..');
}

function getFixtureManifest(fixtureRoot: string): Fixture[] {
  const manifestPath = path.join(fixtureRoot, 'fixtures.json');
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Fixture[];
}

function getFixtureScore(summary: string, fixture: Fixture, sourceLength: number): {
  Recall: number;
  Precision: number;
  Faithfulness: number;
  Format: number;
  Compression: number;
  Total: number;
  Notes: string;
} {
  const required = fixture.RequiredTerms || [];
  const forbidden = fixture.ForbiddenTerms || [];
  const matchedRequired = required.filter((term) => term && summary.includes(term)).length;
  const matchedForbidden = forbidden.filter((term) => term && summary.includes(term)).length;

  const recall = required.length === 0 ? 2 : (matchedRequired === required.length ? 2 : (matchedRequired > 0 ? 1 : 0));
  const precision = matchedForbidden === 0 ? 2 : (matchedForbidden < Math.max(forbidden.length, 1) ? 1 : 0);
  const faithfulness = recall === 2 && precision === 2 ? 2 : (recall > 0 && precision > 0 ? 1 : 0);

  let formatScore = 2;
  if (fixture.Format === 'json') {
    try {
      JSON.parse(summary);
    } catch {
      formatScore = 0;
    }
  }

  const ratio = sourceLength > 0 ? (summary.length / sourceLength) : 1;
  const compression = ratio <= 0.6 ? 2 : (ratio <= 0.85 ? 1 : 0);

  return {
    Recall: recall,
    Precision: precision,
    Faithfulness: faithfulness,
    Format: formatScore,
    Compression: compression,
    Total: recall + precision + faithfulness + formatScore + compression,
    Notes: `required matched: ${matchedRequired}/${required.length}; forbidden matched: ${matchedForbidden}/${forbidden.length}`,
  };
}

export async function runEvaluation(request: EvalRequest): Promise<{
  Backend: string;
  Model: string;
  ResultPath: string;
  Results: Array<Record<string, unknown>>;
}> {
  return withExecutionLock(async () => {
    const config = await loadConfig({ ensure: true });
    const backend = request.Backend || config.Backend;
    const model = request.Model || getConfiguredModel(config);
    const fixtureRoot = request.FixtureRoot || path.join(getRepoRoot(), 'eval', 'fixtures');
    const manifest = getFixtureManifest(fixtureRoot);
    const results: Array<Record<string, unknown>> = [];

    for (const fixture of manifest) {
      const sourcePath = path.join(fixtureRoot, fixture.File);
      const source = fs.readFileSync(sourcePath, 'utf8');
      const summaryResult = await summarizeRequest({
        question: fixture.Question,
        inputText: source,
        format: fixture.Format,
        backend,
        model,
        policyProfile: fixture.PolicyProfile,
        sourceKind: 'standalone',
      });
      const score = getFixtureScore(summaryResult.Summary, fixture, source.length);

      results.push({
        Name: fixture.Name,
        SourcePath: sourcePath,
        WasSummarized: summaryResult.WasSummarized,
        PolicyDecision: summaryResult.PolicyDecision,
        Classification: summaryResult.Classification,
        RawReviewRequired: summaryResult.RawReviewRequired,
        ModelCallSucceeded: summaryResult.ModelCallSucceeded,
        Summary: summaryResult.Summary,
        Recall: score.Recall,
        Precision: score.Precision,
        Faithfulness: score.Faithfulness,
        Format: score.Format,
        Compression: score.Compression,
        Total: score.Total,
        Notes: score.Notes,
      });
    }

    for (const logPath of request.RealLogPath || []) {
      if (!fs.existsSync(logPath)) {
        continue;
      }

      const source = fs.readFileSync(logPath, 'utf8');
      const summaryResult = await summarizeRequest({
        question: 'Summarize the important result in up to 5 bullets, preserving only the decisive facts.',
        inputText: source,
        format: 'text',
        backend,
        model,
        policyProfile: 'general',
        sourceKind: 'standalone',
      });

      results.push({
        Name: `RealLog:${path.basename(logPath)}`,
        SourcePath: logPath,
        WasSummarized: summaryResult.WasSummarized,
        PolicyDecision: summaryResult.PolicyDecision,
        Classification: summaryResult.Classification,
        RawReviewRequired: summaryResult.RawReviewRequired,
        ModelCallSucceeded: summaryResult.ModelCallSucceeded,
        Summary: summaryResult.Summary,
        Recall: null,
        Precision: null,
        Faithfulness: null,
        Format: null,
        Compression: null,
        Total: null,
        Notes: 'Manual review required for real-log scoring.',
      });
    }

    const paths = initializeRuntime();
    const resultPath = newArtifactPath(paths.EvalResults, 'evaluation', 'json');
    saveContentAtomically(resultPath, JSON.stringify(results, null, 2));

    return {
      Backend: backend,
      Model: model,
      ResultPath: resultPath,
      Results: results,
    };
  });
}
