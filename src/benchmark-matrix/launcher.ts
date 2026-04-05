import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { ensureDirectory } from '../lib/fs.js';
import { getRequiredString } from './args.js';
import { invokeConfigGet, getRuntimeLlamaCppConfigValue, waitForLlamaReadiness } from './config-rpc.js';
import { readTrimmedFileText } from './manifest.js';
import { spawnAndWait } from './process.js';
import { pruneOldLauncherLogs } from './pruning.js';
import {
  powerShellExe,
  repoRoot,
  type LaunchResult,
  type ResolvedMatrixManifest,
  type ResolvedMatrixTarget,
} from './types.js';

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
  outputPath: string,
  promptPrefixFile: string | null,
): string[] {
  const args = [
    path.join(repoRoot, 'dist', 'benchmark.js'),
    '--fixture-root',
    manifest.fixtureRoot,
    '--model',
    run.modelId,
    '--output',
    outputPath,
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

export async function invokeStopScript(stopScriptPath: string): Promise<void> {
  const result = await spawnAndWait({
    filePath: powerShellExe,
    args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', stopScriptPath, '-Force'],
    cwd: path.dirname(stopScriptPath),
    stdoutPath: path.join(repoRoot, 'eval', 'results', 'tmp_stop_stdout.log'),
    stderrPath: path.join(repoRoot, 'eval', 'results', 'tmp_stop_stderr.log'),
  });

  if (result.exitCode !== 0) {
    throw new Error(`Stop script failed with exit code ${result.exitCode}.`);
  }
}

export async function forceStopLlamaServer(sessionDirectory: string): Promise<void> {
  const stdoutPath = path.join(sessionDirectory, 'tmp_force_stop_stdout.log');
  const stderrPath = path.join(sessionDirectory, 'tmp_force_stop_stderr.log');
  const result = await spawnAndWait({
    filePath: powerShellExe,
    args: [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-Command',
      "$existing = Get-Process 'llama-server' -ErrorAction SilentlyContinue; if ($existing) { $existing | Stop-Process -Force }; exit 0",
    ],
    cwd: repoRoot,
    stdoutPath,
    stderrPath,
  });

  if (result.exitCode !== 0) {
    throw new Error(`Force-stopping llama-server failed with exit code ${result.exitCode}.`);
  }

  await new Promise((resolve) => setTimeout(resolve, 1_000));
}

export async function startLlamaLauncher(
  manifest: ResolvedMatrixManifest,
  target: ResolvedMatrixTarget,
  sessionDirectory: string,
): Promise<LaunchResult> {
  pruneOldLauncherLogs(manifest.resultsRoot);
  const stdoutPath = path.join(sessionDirectory, `launcher_${target.index}_${target.id}_stdout.log`);
  const stderrPath = path.join(sessionDirectory, `launcher_${target.index}_${target.id}_stderr.log`);
  const args = buildLauncherArgs(manifest, target);

  ensureDirectory(sessionDirectory);
  const stdoutFd = fs.openSync(stdoutPath, 'w');
  const stderrFd = fs.openSync(stderrPath, 'w');
  const child = spawn(powerShellExe, args, {
    cwd: path.dirname(target.startScript),
    stdio: ['ignore', stdoutFd, stderrFd],
    windowsHide: true,
    detached: false,
  });

  await new Promise((resolve) => setTimeout(resolve, 1_000));
  const exited = child.exitCode !== null || child.signalCode !== null;
  fs.closeSync(stdoutFd);
  fs.closeSync(stderrFd);

  if (exited) {
    const stderrText = readTrimmedFileText(stderrPath);
    const stdoutText = readTrimmedFileText(stdoutPath);
    const details = [stderrText, stdoutText].filter(Boolean).join(' ').trim();
    throw new Error(`Launcher process exited before llama-server became ready.${details ? ` ${details}` : ''}`);
  }

  return {
    hostProcessId: child.pid ?? 0,
    stdoutPath,
    stderrPath,
  };
}

export async function restartLlamaForTarget(
  manifest: ResolvedMatrixManifest,
  target: ResolvedMatrixTarget,
  sessionDirectory: string,
): Promise<void> {
  process.stdout.write(`Restarting llama-server for [${target.id}] ${target.label}\n`);
  if (manifest.stopScript) {
    await invokeStopScript(manifest.stopScript);
  } else {
    await forceStopLlamaServer(sessionDirectory);
  }
  await startLlamaLauncher(manifest, target, sessionDirectory);
  const config = await invokeConfigGet(manifest.configUrl);
  const baseUrl = getRequiredString(getRuntimeLlamaCppConfigValue(config, 'BaseUrl'), 'config.Runtime.LlamaCpp.BaseUrl');
  await waitForLlamaReadiness(baseUrl, target.modelId);
}
