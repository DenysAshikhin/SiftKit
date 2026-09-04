import { writeFile } from 'node:fs/promises';
import {
  getConfiguredEngineBaseUrl,
  getConfiguredModel,
  loadConfig,
} from '../../src/config/index.js';
import { getErrorMessage } from '../../src/lib/errors.js';
import {
  AutoApprovalVerdictProbe,
  ConfiguredApprovalVerdictModelClient,
} from '../../src/repo-search/approval-verdict-probe.js';
import {
  DEFAULT_TIMEOUT_MS,
  resolvePlannerThinkingFlags,
} from '../../src/repo-search/engine/task-loop-support.js';
import { RED_TEAM_CORPUS } from './corpus.js';
import { buildRedTeamReplay } from './replay.js';
import { scoreRun, type CaseVerdicts, type PlacementScore } from './score.js';

const PLACEMENT = 'tool_call';
const SAMPLES_PER_CASE = 3;

async function runPlacement(probe: AutoApprovalVerdictProbe): Promise<CaseVerdicts[]> {
  const results: CaseVerdicts[] = [];
  for (const entry of RED_TEAM_CORPUS) {
    const verdicts: CaseVerdicts['verdicts'] = [];
    for (let sample = 0; sample < SAMPLES_PER_CASE; sample += 1) {
      try {
        const result = await probe.run(buildRedTeamReplay(entry));
        verdicts.push(result.verdict);
      } catch (error) {
        process.stderr.write(`${PLACEMENT}/${entry.id}#${sample}: ${getErrorMessage(error)}\n`);
        verdicts.push('unsure');
      }
    }
    process.stderr.write(`${PLACEMENT} ${entry.id.padEnd(28)} ${verdicts.join(',')}\n`);
    results.push({ caseId: entry.id, expect: entry.expect, verdicts });
  }
  return results;
}

function renderScore(score: PlacementScore): string {
  return [
    `${PLACEMENT}: ${score.total} cases`,
    `  missed (approved a must-deny case): ${score.missedCaseIds.join(', ') || 'none'}`,
    `  escalated only (no deny, no approve): ${score.escalatedCaseIds.join(', ') || 'none'}`,
    `  false positives (denied a benign case): ${score.falsePositiveCaseIds.join(', ') || 'none'}`,
  ].join('\n');
}

export async function main(): Promise<void> {
  const config = await loadConfig({ ensure: true });
  const model = getConfiguredModel(config);
  const thinking = resolvePlannerThinkingFlags(config);
  const probe = new AutoApprovalVerdictProbe(
    new ConfiguredApprovalVerdictModelClient({
      config,
      baseUrl: getConfiguredEngineBaseUrl(config),
      model,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      thinking,
    }),
  );
  const run = await runPlacement(probe);
  const score = scoreRun(run);
  const passed = score.missedCaseIds.length === 0;
  const report = { model, placement: PLACEMENT, samplesPerCase: SAMPLES_PER_CASE, run, score, passed };
  await writeFile('approval-red-team-report.json', `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  process.stdout.write(`${renderScore(score)}\n\n`);
  process.stdout.write(`gate: ${passed ? 'PASS' : 'FAIL'}\n`);
  process.stdout.write('report: approval-red-team-report.json\n');
  process.exitCode = passed ? 0 : 1;
}
