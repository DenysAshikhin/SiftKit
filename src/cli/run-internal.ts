import * as fs from 'node:fs';
import { ensureStatusServerReachable, loadConfig, setTopLevelConfigKey } from '../config/index.js';
import { analyzeCommandOutput, runCommand } from '../command.js';
import { runEvaluation } from '../eval.js';
import { findFiles } from '../find-files.js';
import { installCodexPolicy, installShellIntegration, installSiftKit } from '../install.js';
import { runInteractiveCapture } from '../interactive.js';
import { executeRepoSearchRequest } from '../repo-search/index.js';
import { summarizeRequest } from '../summary/core.js';
import { getCommandArgs, parseArguments, SERVER_DEPENDENT_INTERNAL_OPS } from './args.js';
import { buildTestResult } from './run-test.js';

function readRequestFile(filePath: string): Record<string, unknown> {
  const text = fs.readFileSync(filePath, 'utf8');
  const normalized = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
  return JSON.parse(normalized) as Record<string, unknown>;
}

export async function runInternal(options: {
  argv: string[];
  stdout: NodeJS.WritableStream;
}): Promise<number> {
  const parsed = parseArguments(getCommandArgs(options.argv));
  if (!parsed.op) {
    throw new Error('An --op is required.');
  }
  if (!parsed.requestFile) {
    throw new Error('A --request-file is required.');
  }

  if (SERVER_DEPENDENT_INTERNAL_OPS.has(parsed.op)) {
    await ensureStatusServerReachable();
  }

  const request = readRequestFile(parsed.requestFile);
  let result: unknown;
  switch (parsed.op) {
    case 'install':
      result = await installSiftKit(Boolean(request.Force));
      break;
    case 'test':
      result = await buildTestResult();
      break;
    case 'config-get':
      result = await loadConfig({ ensure: true });
      break;
    case 'config-set':
      result = await setTopLevelConfigKey(String(request.Key), request.Value);
      break;
    case 'summary': {
      const text = request.TextFile ? fs.readFileSync(String(request.TextFile), 'utf8') : String(request.Text || '');
      result = await summarizeRequest({
        question: String(request.Question),
        inputText: text,
        format: (request.Format === 'json' ? 'json' : 'text'),
        policyProfile: ((request.PolicyProfile as Parameters<typeof summarizeRequest>[0]['policyProfile']) || 'general'),
        backend: request.Backend ? String(request.Backend) : undefined,
        model: request.Model ? String(request.Model) : undefined,
      });
      break;
    }
    case 'command':
      result = await runCommand({
        Command: String(request.Command),
        ArgumentList: Array.isArray(request.ArgumentList) ? request.ArgumentList.map(String) : [],
        Question: request.Question ? String(request.Question) : undefined,
        RiskLevel: request.RiskLevel as 'informational' | 'debug' | 'risky' | undefined,
        ReducerProfile: request.ReducerProfile as 'smart' | 'errors' | 'tail' | 'diff' | 'none' | undefined,
        Format: request.Format === 'json' ? 'json' : 'text',
        PolicyProfile: request.PolicyProfile as Parameters<typeof summarizeRequest>[0]['policyProfile'] | undefined,
        Backend: request.Backend ? String(request.Backend) : undefined,
        Model: request.Model ? String(request.Model) : undefined,
        NoSummarize: Boolean(request.NoSummarize),
      });
      break;
    case 'command-analyze': {
      const text = request.RawTextFile ? fs.readFileSync(String(request.RawTextFile), 'utf8') : String(request.RawText || '');
      result = await analyzeCommandOutput({
        ExitCode: Number(request.ExitCode || 0),
        CombinedText: text,
        Question: request.Question ? String(request.Question) : undefined,
        RiskLevel: request.RiskLevel as 'informational' | 'debug' | 'risky' | undefined,
        ReducerProfile: request.ReducerProfile as 'smart' | 'errors' | 'tail' | 'diff' | 'none' | undefined,
        Format: request.Format === 'json' ? 'json' : 'text',
        PolicyProfile: request.PolicyProfile as Parameters<typeof summarizeRequest>[0]['policyProfile'] | undefined,
        Backend: request.Backend ? String(request.Backend) : undefined,
        Model: request.Model ? String(request.Model) : undefined,
        NoSummarize: Boolean(request.NoSummarize),
      });
      break;
    }
    case 'eval':
      result = await runEvaluation({
        FixtureRoot: request.FixtureRoot ? String(request.FixtureRoot) : undefined,
        RealLogPath: Array.isArray(request.RealLogPath) ? request.RealLogPath.map(String) : [],
        Backend: request.Backend ? String(request.Backend) : undefined,
        Model: request.Model ? String(request.Model) : undefined,
      });
      break;
    case 'find-files':
      result = findFiles((request.Name as string[]).map(String), request.Path ? String(request.Path) : '.');
      break;
    case 'codex-policy':
      result = await installCodexPolicy(request.CodexHome ? String(request.CodexHome) : undefined, Boolean(request.Force));
      break;
    case 'install-global':
      result = await installShellIntegration({
        BinDir: request.BinDir ? String(request.BinDir) : undefined,
        ModuleInstallRoot: request.ModuleRoot ? String(request.ModuleRoot) : undefined,
        Force: Boolean(request.Force),
      });
      break;
    case 'interactive-capture':
      result = await runInteractiveCapture({
        Command: String(request.Command),
        ArgumentList: Array.isArray(request.ArgumentList) ? request.ArgumentList.map(String) : [],
        Question: request.Question ? String(request.Question) : undefined,
        Format: request.Format === 'json' ? 'json' : 'text',
        Backend: request.Backend ? String(request.Backend) : undefined,
        Model: request.Model ? String(request.Model) : undefined,
        PolicyProfile: request.PolicyProfile as Parameters<typeof summarizeRequest>[0]['policyProfile'] | undefined,
      });
      break;
    case 'repo-search':
      result = await executeRepoSearchRequest({
        prompt: String(request.Prompt || ''),
        repoRoot: String(request.RepoRoot || process.cwd()),
        model: request.Model ? String(request.Model) : undefined,
        maxTurns: request.MaxTurns === undefined ? undefined : Number(request.MaxTurns),
        logFile: request.LogFile ? String(request.LogFile) : undefined,
        availableModels: Array.isArray(request.AvailableModels) ? request.AvailableModels.map(String) : undefined,
        mockResponses: Array.isArray(request.MockResponses) ? request.MockResponses.map(String) : undefined,
        mockCommandResults: (
          request.MockCommandResults
          && typeof request.MockCommandResults === 'object'
          && !Array.isArray(request.MockCommandResults)
        ) ? request.MockCommandResults as Record<string, { exitCode?: number; stdout?: string; stderr?: string }> : undefined,
      });
      break;
    default:
      throw new Error(`Unknown internal op: ${parsed.op}`);
  }

  options.stdout.write(`${JSON.stringify(result)}\n`);
  return 0;
}
