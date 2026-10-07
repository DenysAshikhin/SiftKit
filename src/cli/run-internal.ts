import { ensureStatusServerReachable, loadConfig, setTopLevelConfigKey } from '../config/index.ts';
import { resolveExternalCommand } from '../capture/command-path.ts';
import { captureWithTranscript, invokeProcess, invokeShellProcess } from '../capture/process.ts';
import { findFiles } from '../find-files.ts';
import { installCodexPolicy, installShellIntegration, installSiftKit } from '../install.ts';
import { readTextFileWithEncoding } from '../lib/text-encoding.ts';
import { parseJsonValueText } from '../lib/json.ts';
import { JsonRecordReader } from '../lib/json-record-reader.ts';
import type { JsonObject, JsonSerializable } from '../lib/json-types.ts';
import { parseArguments, type ResolvedCliArgs, SERVER_DEPENDENT_INTERNAL_OPS } from './args.ts';
import {
  normalizeCliFormat,
  normalizeCliPolicyProfile,
  normalizeCliPolicyProfileOrDefault,
  normalizeCliReducerProfile,
  normalizeCliRiskLevel,
  normalizeCliShell,
} from './request-normalizers.ts';
import { parseOptionalSummaryProvider } from '../summary/types.ts';
import { buildTestResult } from './run-test.ts';
import { SilentProgressRenderer } from './progress-renderer.ts';
import { StatusServerApiClient } from './status-server-api-client.ts';
import { MockPlannerResponsesSchema } from '../planner-protocol/mock-response.ts';

function readRequestFile(filePath: string): JsonObject {
  return JsonRecordReader.asObject(parseJsonValueText(readTextFileWithEncoding(filePath))) ?? {};
}

/** Single provider boundary parse for every internal op; an unknown provider fails loud. */
function readRequestProvider(request: JsonObject) {
  return parseOptionalSummaryProvider(new JsonRecordReader(request).optionalString('Provider'));
}

export async function runInternal(options: ResolvedCliArgs & {
  stdout: NodeJS.WritableStream;
}): Promise<number> {
  const parsed = parseArguments(options.args);
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
  const renderer = new SilentProgressRenderer(options.stdout, 'internal');
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
        repoRoot: process.cwd(),
        question: String(request.Question),
        inputText: text,
        format: (request.Format === 'json' ? 'json' : 'text'),
        policyProfile: normalizeCliPolicyProfileOrDefault(request.PolicyProfile),
        provider: readRequestProvider(request),
        model: request.Model ? String(request.Model) : undefined,
      }, renderer);
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
        repoRoot: process.cwd(),
        outputKind: 'command',
        exitCode: processResult.ExitCode,
        combinedText: processResult.Combined,
        commandText: shell ? `[${shell}] ${command}` : [command, ...argumentList].join(' '),
        question: request.Question ? String(request.Question) : undefined,
        riskLevel: normalizeCliRiskLevel(request.RiskLevel),
        reducerProfile: normalizeCliReducerProfile(request.ReducerProfile),
        format: normalizeCliFormat(request.Format),
        policyProfile: normalizeCliPolicyProfile(request.PolicyProfile),
        provider: readRequestProvider(request),
        model: request.Model ? String(request.Model) : undefined,
        noSummarize: Boolean(request.NoSummarize),
        shell,
      }, renderer);
      break;
    }
    case 'command-analyze': {
      const text = request.RawTextFile ? readTextFileWithEncoding(String(request.RawTextFile)) : String(request.RawText || '');
      result = await apiClient.analyzeCommandOutput({
        repoRoot: process.cwd(),
        outputKind: 'command',
        exitCode: Number(request.ExitCode || 0),
        combinedText: text,
        commandText: request.CommandText ? String(request.CommandText) : undefined,
        question: request.Question ? String(request.Question) : undefined,
        riskLevel: normalizeCliRiskLevel(request.RiskLevel),
        reducerProfile: normalizeCliReducerProfile(request.ReducerProfile),
        format: normalizeCliFormat(request.Format),
        policyProfile: normalizeCliPolicyProfile(request.PolicyProfile),
        provider: readRequestProvider(request),
        model: request.Model ? String(request.Model) : undefined,
        noSummarize: Boolean(request.NoSummarize),
      }, renderer);
      break;
    }
    case 'eval':
      result = await apiClient.runEvaluation({
        FixtureRoot: request.FixtureRoot ? String(request.FixtureRoot) : undefined,
        RealLogPath: Array.isArray(request.RealLogPath) ? request.RealLogPath.map(String) : [],
        Provider: readRequestProvider(request),
        Model: request.Model ? String(request.Model) : undefined,
      }, renderer);
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
        repoRoot: process.cwd(),
        outputKind: 'interactive',
        exitCode: captured.ExitCode,
        combinedText: captured.Transcript.trim() ? captured.Transcript : fallbackTranscript,
        commandText: [command, ...argumentList].join(' '),
        question: request.Question ? String(request.Question) : undefined,
        format: normalizeCliFormat(request.Format),
        policyProfile: normalizeCliPolicyProfile(request.PolicyProfile),
        provider: readRequestProvider(request),
        model: request.Model ? String(request.Model) : undefined,
      }, renderer);
      break;
    }
    case 'repo-search':
      result = await apiClient.requestRepoSearch({
        presetId: 'repo-search',
        prompt: String(request.Prompt || ''),
        repoRoot: String(request.RepoRoot || process.cwd()),
        model: request.Model ? String(request.Model) : undefined,
        maxTurns: request.MaxTurns === undefined ? undefined : Number(request.MaxTurns),
        logFile: request.LogFile ? String(request.LogFile) : undefined,
        availableModels: Array.isArray(request.AvailableModels) ? request.AvailableModels.map(String) : undefined,
        mockResponses: Array.isArray(request.MockResponses) ? MockPlannerResponsesSchema.parse(request.MockResponses) : undefined,
        mockCommandResults: JsonRecordReader.asObject(request.MockCommandResults) ?? undefined,
      }, renderer);
      break;
    default:
      throw new Error(`Unknown internal op: ${parsed.op}`);
  }

  options.stdout.write(`${JSON.stringify(result)}\n`);
  return 0;
}
