import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import type { Exl3EngineConfig, ModelRuntimePreset } from '../config/types.js';
import { LlamaCppClient } from '../llm-protocol/llama-cpp-client.js';
import { ManagedInferenceRuntime } from './managed-inference-runtime.js';
import { terminateProcessTree } from './managed-llama.js';
import { getManagedTabbyLogRoot } from './paths.js';

const tabbyCapabilities = {
  chatTemplateKwargs: true,
  reasoningContent: true,
  toolCalling: true,
  jsonSchema: true,
  speculativeMode: 'mtp',
  reusablePrefixCache: 'unknown',
} as const;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class ManagedTabbyRuntime extends ManagedInferenceRuntime {
  private child: ChildProcess | null = null;
  private readonly client = new LlamaCppClient();
  private stopping = false;
  private startupError: Error | null = null;
  private readonly logPath: string;

  constructor(
    private readonly engine: Exl3EngineConfig,
    private readonly preset: ModelRuntimePreset,
  ) {
    super('exl3', preset.BaseUrl ?? 'http://127.0.0.1:8098', preset.Model ?? 'exl3', tabbyCapabilities);
    this.logPath = path.join(getManagedTabbyLogRoot(), 'latest-startup.log');
  }

  async start(): Promise<void> {
    if (!this.engine.Managed) {
      this.transitionTo('starting');
      await this.waitUntilReady();
      return;
    }
    if (this.child && this.child.exitCode === null) {
      await this.waitUntilReady();
      return;
    }

    this.transitionTo('starting');
    this.stopping = false;
    this.startupError = null;
    fs.mkdirSync(path.dirname(this.logPath), { recursive: true });
    fs.writeFileSync(this.logPath, '', 'utf8');
    const child = spawn(this.engine.PythonPath, [this.engine.Entrypoint], {
      cwd: this.engine.WorkingDirectory,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;
    child.stdout?.on('data', (chunk) => this.appendLog('stdout', chunk));
    child.stderr?.on('data', (chunk) => this.appendLog('stderr', chunk));
    child.once('error', (error) => {
      this.startupError = error;
      this.transitionTo('failed');
    });
    child.once('exit', (code, signal) => {
      if (this.stopping) {
        return;
      }
      this.startupError = new Error(`TabbyAPI exited unexpectedly (code=${String(code)}, signal=${String(signal)}).`);
      this.transitionTo('failed');
    });
    try {
      await this.waitUntilReady();
    } catch (error) {
      try {
        await this.stop();
      } finally {
        this.transitionTo('failed');
      }
      throw error;
    }
  }

  async waitUntilReady(): Promise<void> {
    const deadline = Date.now() + this.preset.StartupTimeoutMs;
    while (Date.now() < deadline) {
      if (this.startupError) {
        throw this.startupError;
      }
      try {
        const response = await this.client.probeModelsAtBaseUrl(
          this.preset.BaseUrl ?? 'http://127.0.0.1:8098',
          this.preset.HealthcheckTimeoutMs,
        );
        if (response.statusCode < 400 && this.preset.Model !== null && response.models.includes(this.preset.Model)) {
          this.transitionTo('ready');
          return;
        }
      } catch {
        // Cold model loading can reject connections until the API is ready.
      }
      await delay(this.preset.HealthcheckIntervalMs);
    }
    this.transitionTo('failed');
    throw new Error(`Timed out waiting for TabbyAPI model '${this.preset.Model ?? 'exl3'}'.`);
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child || child.exitCode !== null) {
      this.child = null;
      this.transitionTo('stopped');
      return;
    }
    this.stopping = true;
    this.transitionTo('stopping');
    if (child.pid) {
      terminateProcessTree(child.pid);
    }
    const deadline = Date.now() + this.engine.ShutdownTimeoutMs;
    while (child.exitCode === null && Date.now() < deadline) {
      await delay(25);
    }
    if (child.exitCode === null) {
      this.transitionTo('failed');
      throw new Error('Timed out stopping TabbyAPI.');
    }
    this.child = null;
    this.transitionTo('stopped');
  }

  stopForProcessExitSync(): void {
    const child = this.child;
    this.stopping = true;
    if (child?.pid && child.exitCode === null) {
      terminateProcessTree(child.pid);
    }
    this.child = null;
    this.transitionTo('stopped');
  }

  private appendLog(stream: 'stdout' | 'stderr', chunk: string | Buffer): void {
    fs.appendFileSync(this.logPath, `[${stream}] ${String(chunk)}`, 'utf8');
  }
}
