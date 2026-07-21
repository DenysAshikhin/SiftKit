import { ensureStatusServerReachable, loadConfig, setTopLevelConfigKey } from '../config/index.js';
import { resolveExternalCommand } from '../capture/command-path.js';
import { captureWithTranscript, invokeProcess, invokeShellProcess } from '../capture/process.js';
import { findFiles } from '../find-files.js';
import { installCodexPolicy, installShellIntegration, installSiftKit } from '../install.js';
import { readTextFileWithEncoding } from '../lib/text-encoding.js';
import { parseJsonValueText } from '../lib/json.js';
import { JsonRecordReader } from '../lib/json-record-reader.js';
import type { JsonObject, JsonSerializable } from '../lib/json-types.js';
import { getCommandArgs, parseArguments, SERVER_DEPENDENT_INTERNAL_OPS } from './args.js';
import {
  normalizeCliFormat,
  normalizeCliPolicyProfile,
  normalizeCliPolicyProfileOrDefault,
  normalizeCliReducerProfile,
  normalizeCliRiskLevel,
  normalizeCliShell,
} from './request-normalizers.js';
import { parseOptionalSummaryProvider } from '../summary/types.js';
import { buildTestResult } from './run-test.js';
import { StatusServerApiClient } from './status-server-api-client.js';

function readRequestFile(filePath: string): JsonObject {
  return JsonRecordReader.asObject(parseJsonValueText(readTextFileWithEncoding(filePath))) ?? {};
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
  const apiClient = new StatusServerApiClient();
  let result: JsonSerializable;
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
      const text = request.TextFile ? readTextFileWithEncoding(String(request.TextFile)) : String(request.Text || '');
      result = await apiClient.requestSummary({
        question: String(request.Question),
        inputText: text,
        format: (request.Format === 'json' ? 'json' : 'text'),
        policyProfile: normalizeCliPolicyProfileOrDefault(request.PolicyProfile),
        backend: parseOptionalSummaryProvider(request.Backend ? String(request.Backend) : undefined),
        model: request.Model ? String(request.Model) : undefined,
      });
      break;
    }
    case 'command': {
      const command = String(request.Command);
      const argumentList = Array.isArray(request.ArgumentList) ? request.ArgumentList.map(String) : [];
      const shell = normalizeCliShell(request.Shell);
      if (request.Shell && !shell) {
        throw new Error(`Unsupported shell: ${request.Shell}`);
      }
      const processResult = shell
        ? invokeShellProcess(command, shell)
        : invokeProcess(command, argumentList);
      result = await apiClient.analyzeCommandOutput({
        outputKind: 'command',
        exitCode: processResult.ExitCode,
        combinedText: processResult.Combined,
        commandText: shell ? `[${shell}] ${command}` : [command, ...argumentList].join(' '),
        question: request.Question ? String(request.Question) : undefined,
        riskLevel: normalizeCliRiskLevel(request.RiskLevel),
        reducerProfile: normalizeCliReducerProfile(request.ReducerProfile),
        format: normalizeCliFormat(request.Format),
        policyProfile: normalizeCliPolicyProfile(request.PolicyProfile),
        backend: parseOptionalSummaryProvider(request.Backend ? String(request.Backend) : undefined),
        model: request.Model ? String(request.Model) : undefined,
        noSummarize: Boolean(request.NoSummarize),
        shell,
      });
      break;
    }
    case 'command-analyze': {
      const text = request.RawTextFile ? readTextFileWithEncoding(String(request.RawTextFile)) : String(request.RawText || '');
      result = await apiClient.analyzeCommandOutput({
        outputKind: 'command',
        exitCode: Number(request.ExitCode || 0),
        combinedText: text,
        commandText: request.CommandText ? String(request.CommandText) : undefined,
        question: request.Question ? String(request.Question) : undefined,
        riskLevel: normalizeCliRiskLevel(request.RiskLevel),
        reducerProfile: normalizeCliReducerProfile(request.ReducerProfile),
        format: normalizeCliFormat(request.Format),
        policyProfile: normalizeCliPolicyProfile(request.PolicyProfile),
        backend: parseOptionalSummaryProvider(request.Backend ? String(request.Backend) : undefined),
        model: request.Model ? String(request.Model) : undefined,
        noSummarize: Boolean(request.NoSummarize),
      });
      break;
    }
    case 'eval':
      result = await apiClient.runEvaluation({
        FixtureRoot: request.FixtureRoot ? String(request.FixtureRoot) : undefined,
        RealLogPath: Array.isArray(request.RealLogPath) ? request.RealLogPath.map(String) : [],
        Backend: parseOptionalSummaryProvider(request.Backend ? String(request.Backend) : undefined),
        Model: request.Model ? String(request.Model) : undefined,
      });
      break;
    case 'find-files':
      result = findFiles(
        Array.isArray(request.Name) ? request.Name.map(String) : [],
        request.Path ? String(request.Path) : '.',
      );
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
    case 'interactive-capture': {
      const command = String(request.Command);
      const argumentList = Array.isArray(request.ArgumentList) ? request.ArgumentList.map(String) : [];
      const captured = captureWithTranscript(resolveExternalCommand(command), argumentList);
      const fallbackTranscript = `Interactive command completed without a captured transcript.\nCommand: ${command} ${argumentList.join(' ')}\nExitCode: ${captured.ExitCode}`;
      result = await apiClient.analyzeCommandOutput({
        outputKind: 'interactive',
        exitCode: captured.ExitCode,
        combinedText: captured.Transcript.trim() ? captured.Transcript : fallbackTranscript,
        commandText: [command, ...argumentList].join(' '),
        question: request.Question ? String(request.Question) : undefined,
        format: normalizeCliFormat(request.Format),
        policyProfile: normalizeCliPolicyProfile(request.PolicyProfile),
        backend: parseOptionalSummaryProvider(request.Backend ? String(request.Backend) : undefined),
        model: request.Model ? String(request.Model) : undefined,
      });
      break;
    }
    case 'repo-search':
      result = await apiClient.requestRepoSearch({
        prompt: String(request.Prompt || ''),
        repoRoot: String(request.RepoRoot || process.cwd()),
        model: request.Model ? String(request.Model) : undefined,
        maxTurns: request.MaxTurns === undefined ? undefined : Number(request.MaxTurns),
        logFile: request.LogFile ? String(request.LogFile) : undefined,
        availableModels: Array.isArray(request.AvailableModels) ? request.AvailableModels.map(String) : undefined,
        mockResponses: Array.isArray(request.MockResponses) ? request.MockResponses.map(String) : undefined,
        mockCommandResults: JsonRecordReader.asObject(request.MockCommandResults) ?? undefined,
      });
      break;
    default:
      throw new Error(`Unknown internal op: ${parsed.op}`);
  }

  options.stdout.write(`${JSON.stringify(result)}\n`);
  return 0;
}
