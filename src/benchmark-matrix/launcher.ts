import { spawn } from 'node:child_process';
import { appendBenchmarkMatrixLogChunk } from '../state/benchmark-matrix.js';
import { sleep } from '../lib/time.js';
import { getRequiredString } from './args.js';
import { invokeConfigGet, getRuntimeLlamaCppConfigValue, waitForLlamaReadiness } from './config-rpc.js';
import { spawnAndWait } from './process.js';
import {
  powerShellExe,
  repoRoot,
  type LaunchResult,
  type ResolvedMatrixManifest,
  type ResolvedMatrixTarget,
} from './types.js';

function appendMatrixLog(runId: string | null, streamKind: Parameters<typeof appendBenchmarkMatrixLogChunk>[0]['streamKind'], chunk: string): void {
  if (!runId || !chunk) {
    return;
  }
  appendBenchmarkMatrixLogChunk({
    runId,
    streamKind,
    chunkText: chunk,
  });
}

export function buildLaunchSignature(target: ResolvedMatrixTarget): string {
  return [
    target.startScript,
    target.resolvedModelPath,
    String(target.contextSize),
    String(target.maxTokens),
    target.passReasoningArg ? target.reasoning : 'script-controlled',
  ].join('|');
}

export function buildLauncherArgs(
  manifest: ResolvedMatrixManifest,
  target: ResolvedMatrixTarget,
): string[] {
  const args = [
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', target.startScript,
    '-ConfigUrl', manifest.configUrl,
    '-ModelPath', target.modelPath,
    '-ContextSize', String(target.contextSize),
    '-MaxTokens', String(target.maxTokens),
  ];
  if (target.passReasoningArg) {
    args.push('-Reasoning', target.reasoning);
  }

  return args;
}

export function buildBenchmarkArgs(
  manifest: ResolvedMatrixManifest,
  run: ResolvedMatrixTarget,
  promptPrefixFile: string | null,
): string[] {
  const args = [
    '--fixture-root',
    manifest.fixtureRoot,
    '--model',
    run.modelId,
  ];
  if (promptPrefixFile) {
    args.push('--prompt-prefix-file', promptPrefixFile);
  }
  args.push('--request-timeout-seconds', String(manifest.requestTimeoutSeconds));
  if (run.sampling) {
    args.push(
      '--temperature', String(run.sampling.temperature),
      '--top-p', String(run.sampling.topP),
      '--top-k', String(run.sampling.topK),
      '--min-p', String(run.sampling.minP),
      '--presence-penalty', String(run.sampling.presencePenalty),
      '--repetition-penalty', String(run.sampling.repetitionPenalty),
    );
  }
  args.push('--max-tokens', String(run.maxTokens));

  return args;
}

export async function invokeStopScript(stopScriptPath: string, runId: string | null = null): Promise<void> {
  const result = await spawnAndWait({
    filePath: powerShellExe,
    args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', stopScriptPath, '-Force'],
    cwd: repoRoot,
    env: process.env,
    onStdoutChunk(chunk: string) {
      appendMatrixLog(runId, 'stop_stdout', chunk);
    },
    onStderrChunk(chunk: string) {
      appendMatrixLog(runId, 'stop_stderr', chunk);
    },
  });

  if (result.exitCode !== 0) {
    throw new Error(`Stop script failed with exit code ${result.exitCode}.`);
  }
}

export async function forceStopLlamaServer(runId: string | null = null): Promise<void> {
  const result = await spawnAndWait({
    filePath: powerShellExe,
    args: [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-Command',
      "$existing = Get-Process 'llama-server' -ErrorAction SilentlyContinue; if ($existing) { $existing | Stop-Process -Force }; exit 0",
    ],
    cwd: repoRoot,
    env: process.env,
    onStdoutChunk(chunk: string) {
      appendMatrixLog(runId, 'force_stop_stdout', chunk);
    },
    onStderrChunk(chunk: string) {
      appendMatrixLog(runId, 'force_stop_stderr', chunk);
    },
  });

  if (result.exitCode !== 0) {
    throw new Error(`Force-stopping llama-server failed with exit code ${result.exitCode}.`);
  }

  await sleep(1_000);
}

export async function startLlamaLauncher(
  manifest: ResolvedMatrixManifest,
  target: ResolvedMatrixTarget,
  runId: string | null = null,
): Promise<LaunchResult> {
  const args = buildLauncherArgs(manifest, target);
  const child = spawn(powerShellExe, args, {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    detached: false,
  });
  let stdout = '';
  let stderr = '';
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string | Buffer) => {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    stdout = `${stdout}${text}`;
    appendMatrixLog(runId, 'launcher_stdout', text);
  });
  child.stderr?.on('data', (chunk: string | Buffer) => {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    stderr = `${stderr}${text}`;
    appendMatrixLog(runId, 'launcher_stderr', text);
  });

  await sleep(1_000);
  const exited = child.exitCode !== null || child.signalCode !== null;
  if (exited) {
    const details = [stderr.trim(), stdout.trim()].filter(Boolean).join(' ').trim();
    throw new Error(`Launcher process exited before llama-server became ready.${details ? ` ${details}` : ''}`);
  }

  return {
    runId: runId || '',
    hostProcessId: child.pid ?? 0,
  };
}

export async function restartLlamaForTarget(
  manifest: ResolvedMatrixManifest,
  target: ResolvedMatrixTarget,
  runId: string | null = null,
): Promise<void> {
  process.stdout.write(`Restarting llama-server for [${target.id}] ${target.label}\n`);
  if (manifest.stopScript) {
    await invokeStopScript(manifest.stopScript, runId);
  } else {
    await forceStopLlamaServer(runId);
  }
  await startLlamaLauncher(manifest, target, runId);
  const config = await invokeConfigGet(manifest.configUrl);
  const baseUrl = getRequiredString(getRuntimeLlamaCppConfigValue(config, 'BaseUrl'), 'config.Runtime.LlamaCpp.BaseUrl');
  await waitForLlamaReadiness(baseUrl, target.modelId);
}
