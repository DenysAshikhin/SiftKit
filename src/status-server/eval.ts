import { existsSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { z } from '../lib/zod.js';
import { JsonObjectSchema } from '../lib/json-types.js';
import { parseJsonValueText } from '../lib/json.js';
import { getConfiguredModel, initializeRuntime, loadConfig } from '../config/index.js';
import { summarizeRequest } from '../summary/core.js';
import { resolveSummaryProvider } from '../summary/types.js';
import { upsertRuntimeJsonArtifact } from '../state/runtime-artifacts.js';
import { persistEvalResult } from '../state/runtime-results.js';
import { findNearestSiftKitRepoRoot, moduleDirname } from '../lib/paths.js';
import type { EvalCaseResult, EvalRequest, EvaluationResult } from '../eval-types.js';

const FixtureSchema = z.object({
  Name: z.string(),
  File: z.string(),
  Question: z.string(),
  Format: z.enum(['text', 'json']),
  PolicyProfile: z.enum(['general', 'pass-fail', 'unique-errors', 'buried-critical', 'json-extraction', 'diff-summary', 'risky-operation']),
  RequiredTerms: z.array(z.string()).optional(),
  ForbiddenTerms: z.array(z.string()).optional(),
});
type Fixture = z.infer<typeof FixtureSchema>;

function getFixtureManifest(fixtureRoot: string): Fixture[] {
  const manifestPath = join(fixtureRoot, 'fixtures.json');
  return z.array(FixtureSchema).parse(parseJsonValueText(readFileSync(manifestPath, 'utf8')));
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

export async function runEvaluation(request: EvalRequest): Promise<EvaluationResult> {
  const config = await loadConfig({ ensure: true });
  const backend = resolveSummaryProvider(request.Backend);
  const model = request.Model || getConfiguredModel(config);
  const repoRoot = findNearestSiftKitRepoRoot(moduleDirname(import.meta.url));
  if (repoRoot === null) {
    throw new Error('Unable to locate the SiftKit repo root for eval fixtures.');
  }
  const fixtureRoot = request.FixtureRoot || join(repoRoot, 'eval', 'fixtures');
  const manifest = getFixtureManifest(fixtureRoot);
  const results: EvalCaseResult[] = [];

  for (const fixture of manifest) {
    const sourcePath = join(fixtureRoot, fixture.File);
    const source = readFileSync(sourcePath, 'utf8');
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
    if (!existsSync(logPath)) {
      continue;
    }

    const source = readFileSync(logPath, 'utf8');
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
      Name: `RealLog:${basename(logPath)}`,
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

  void initializeRuntime();
  const evalResultPayload = JsonObjectSchema.parse({
    backend,
    model,
    results,
  });
  const persistedEvalResult = persistEvalResult({
    payload: evalResultPayload,
  });
  upsertRuntimeJsonArtifact({
    artifactKind: 'eval_result',
    id: persistedEvalResult.id,
    payload: evalResultPayload,
  });

  return {
    Backend: backend,
    Model: model,
    ResultPath: persistedEvalResult.uri,
    Results: results,
  };
}
