import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { initializeRuntime, loadConfig, saveContentAtomically } from './config.js';
import { summarizeRequest } from './summary.js';

export type InteractiveCaptureRequest = {
  Command: string;
  ArgumentList?: string[];
  Question?: string;
  Format?: 'text' | 'json';
  Backend?: string;
  Model?: string;
  PolicyProfile?: 'general' | 'pass-fail' | 'unique-errors' | 'buried-critical' | 'json-extraction' | 'diff-summary' | 'risky-operation';
};

function getTimestamp(): string {
  const current = new Date();
  const yyyy = current.getFullYear();
  const MM = String(current.getMonth() + 1).padStart(2, '0');
  const dd = String(current.getDate()).padStart(2, '0');
  const hh = String(current.getHours()).padStart(2, '0');
  const mm = String(current.getMinutes()).padStart(2, '0');
  const ss = String(current.getSeconds()).padStart(2, '0');
  const fff = String(current.getMilliseconds()).padStart(3, '0');
  return `${yyyy}${MM}${dd}_${hh}${mm}${ss}_${fff}`;
}

function newArtifactPath(directory: string, prefix: string, extension: string): string {
  const safeExtension = extension.replace(/^\./u, '');
  const suffix = `${getTimestamp()}_${process.pid}_${Math.random().toString(16).slice(2, 10)}`;
  return path.join(directory, `${prefix}_${suffix}.${safeExtension}`);
}

function findCommandInPath(commandName: string): string | null {
  const pathEntries = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const candidates = process.platform === 'win32' && !path.extname(commandName)
    ? [commandName, `${commandName}.exe`, `${commandName}.cmd`, `${commandName}.bat`]
    : [commandName];

  for (const entry of pathEntries) {
    for (const candidate of candidates) {
      const fullPath = path.join(entry, candidate);
      if (fs.existsSync(fullPath)) {
        return fullPath;
      }
    }
  }

  if (process.platform === 'win32') {
    const windowsRoot = process.env.WINDIR || 'C:\\Windows';
    const extraCandidates = [
      path.join(windowsRoot, 'System32', commandName),
      path.join(windowsRoot, 'System32', `${commandName}.exe`),
      path.join(windowsRoot, 'System32', 'WindowsPowerShell', 'v1.0', commandName),
      path.join(windowsRoot, 'System32', 'WindowsPowerShell', 'v1.0', `${commandName}.exe`),
    ];
    for (const candidate of extraCandidates) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}

function resolveExternalCommand(commandName: string): string {
  if (path.isAbsolute(commandName) || commandName.includes('\\') || commandName.includes('/')) {
    if (fs.existsSync(commandName)) {
      return commandName;
    }
    throw new Error(`Unable to resolve external command: ${commandName}`);
  }

  const direct = spawnSync('where.exe', [commandName], { encoding: 'utf8', shell: false, windowsHide: true });
  if (direct.status === 0 && direct.stdout.trim()) {
    return direct.stdout.split(/\r?\n/u)[0].trim();
  }

  const fallback = findCommandInPath(commandName);
  if (fallback) {
    return fallback;
  }

  throw new Error(`Unable to resolve external command: ${commandName}`);
}

function quoteForPowerShell(value: string): string {
  return `'${value.replace(/'/gu, "''")}'`;
}

function captureWithTranscript(commandPath: string, argumentList: string[], transcriptPath: string): number {
  const joinedArgs = argumentList.map((entry) => quoteForPowerShell(entry)).join(', ');
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$transcriptPath = ${quoteForPowerShell(transcriptPath)}`,
    `$commandPath = ${quoteForPowerShell(commandPath)}`,
    `Start-Transcript -Path $transcriptPath -Force | Out-Null`,
    'try {',
    `  & $commandPath @(${joinedArgs})`,
    '  if ($null -ne $LASTEXITCODE) { exit [int]$LASTEXITCODE }',
    '  exit 0',
    '} finally {',
    '  try { Stop-Transcript | Out-Null } catch {}',
    '}',
  ].join('\n');

  const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    encoding: 'utf8',
    stdio: 'ignore',
    windowsHide: false,
  });
  return typeof result.status === 'number' ? result.status : 1;
}

export async function runInteractiveCapture(request: InteractiveCaptureRequest): Promise<Record<string, unknown>> {
  const config = await loadConfig({ ensure: true });
  const backend = request.Backend || config.Backend;
  const model = request.Model || config.Model;
  const format = request.Format || 'text';
  const policyProfile = request.PolicyProfile || 'general';
  const question = request.Question || 'Summarize the important result and any actionable failures.';

  const paths = initializeRuntime();
  const transcriptPath = newArtifactPath(paths.Logs, 'interactive_raw', 'log');
  const resolvedCommand = resolveExternalCommand(request.Command);
  let exitCode = 0;

  try {
    exitCode = captureWithTranscript(resolvedCommand, request.ArgumentList || [], transcriptPath);
  } catch {
    saveContentAtomically(transcriptPath, '');
    exitCode = 1;
  }

  let transcriptText = fs.existsSync(transcriptPath) ? fs.readFileSync(transcriptPath, 'utf8') : '';
  if (config.Interactive.MaxTranscriptCharacters && transcriptText.length > Number(config.Interactive.MaxTranscriptCharacters)) {
    transcriptText = transcriptText.substring(transcriptText.length - Number(config.Interactive.MaxTranscriptCharacters));
    saveContentAtomically(transcriptPath, transcriptText);
  }

  if (!transcriptText.trim()) {
    transcriptText = `Interactive command completed without a captured transcript.\nCommand: ${request.Command} ${(request.ArgumentList || []).join(' ')}\nExitCode: ${exitCode}`;
    saveContentAtomically(transcriptPath, transcriptText);
  }

  const summaryResult = await summarizeRequest({
    question,
    inputText: transcriptText,
    format,
    backend,
    model,
    policyProfile,
  });
  const outputText = `${(summaryResult.Summary || 'No summary generated.').trim()}\nRaw transcript: ${transcriptPath}`;

  return {
    ExitCode: exitCode,
    TranscriptPath: transcriptPath,
    WasSummarized: summaryResult.WasSummarized,
    RawReviewRequired: summaryResult.PolicyDecision.startsWith('raw-first') || exitCode !== 0,
    OutputText: outputText,
    Summary: summaryResult.Summary,
  };
}
