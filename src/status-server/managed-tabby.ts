import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import type { Exl3EngineConfig, ModelRuntimePreset } from '../config/types.js';
import { Exl3PresetAdapter } from '../inference-presets/exl3-preset-adapter.js';
import { ManagedInferenceRuntime } from './managed-inference-runtime.js';
import { terminateProcessTree } from './managed-llama.js';
import { getManagedTabbyLogRoot } from './paths.js';
import { TabbyModelClient } from './tabby-model-client.js';

const tabbyCapabilities = {
  chatTemplateKwargs: true,
  reasoningContent: true,
  toolCalling: true,
  jsonSchema: true,
  speculativeMode: 'none',
  reusablePrefixCache: 'unknown',
} as const;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function getBaseUrl(preset: ModelRuntimePreset): string {
  return preset.BaseUrl ?? 'http://127.0.0.1:8098';
}

export class ManagedTabbyRuntime extends ManagedInferenceRuntime {
  private child: ChildProcess | null = null;
  private stopping = false;
  private startupError: Error | null = null;
  private readonly logPath: string;
  private currentPreset: ModelRuntimePreset;
  private processBaseUrl: string | null = null;
  private processManaged: boolean | null = null;
  private residentPresetId: string | null = null;
  private loadPromise: Promise<void> | null = null;

  constructor(
    private readonly engine: Exl3EngineConfig,
    initialPreset: ModelRuntimePreset,
    private readonly client = new TabbyModelClient(engine.AdminApiKey),
  ) {
    super('exl3', tabbyCapabilities);
    this.currentPreset = initialPreset;
    this.logPath = path.join(getManagedTabbyLogRoot(), 'latest-startup.log');
  }

  async startProcess(): Promise<void> {
    if (this.getProcessState() === 'ready') return;
    this.transitionProcessTo('starting');
    if (!this.shouldManage(this.currentPreset)) {
      await this.waitForProcess();
      return;
    }
    if (!this.child || this.child.exitCode !== null) this.spawnProcess();
    try {
      await this.waitForProcess();
    } catch (error) {
      try {
        await this.stopProcess();
      } finally {
        this.transitionProcessTo('failed');
      }
      throw error;
    }
  }

  async ensurePresetReady(preset: ModelRuntimePreset): Promise<void> {
    if (preset.Backend !== 'exl3') {
      throw new Error(`Preset '${preset.id}' cannot be loaded by the EXL3 runtime.`);
    }
    if (
      this.getProcessState() === 'ready'
      && (
        this.processBaseUrl !== getBaseUrl(preset)
        || this.processManaged !== this.shouldManage(preset)
      )
    ) await this.stopProcess();
    this.currentPreset = preset;
    if (this.getProcessState() !== 'ready') await this.startProcess();
    if (this.residentPresetId === preset.id && this.getModelState() === 'ready') return;
    if (this.loadPromise) return this.loadPromise;
    this.loadPromise = this.loadPreset(preset);
    try {
      await this.loadPromise;
    } finally {
      this.loadPromise = null;
    }
  }

  async unloadPreset(): Promise<void> {
    if (this.loadPromise) await this.loadPromise;
    if (this.getModelState() === 'unloaded') return;
    this.transitionModelTo('unloading');
    try {
      await this.client.unload(getBaseUrl(this.currentPreset), this.currentPreset.HealthcheckTimeoutMs);
      this.residentPresetId = null;
      this.transitionModelTo('unloaded');
    } catch (error) {
      this.transitionModelTo('failed');
      throw error;
    }
  }

  async stopProcess(): Promise<void> {
    const child = this.child;
    if (!child || child.exitCode !== null) {
      this.child = null;
      this.processBaseUrl = null;
      this.processManaged = null;
      this.residentPresetId = null;
      this.transitionModelTo('unloaded');
      this.transitionProcessTo('stopped');
      return;
    }
    this.stopping = true;
    this.transitionProcessTo('stopping');
    if (child.pid) terminateProcessTree(child.pid);
    const deadline = Date.now() + this.engine.ShutdownTimeoutMs;
    while (child.exitCode === null && Date.now() < deadline) await delay(25);
    if (child.exitCode === null) {
      this.transitionProcessTo('failed');
      throw new Error('Timed out stopping TabbyAPI.');
    }
    this.child = null;
    this.processBaseUrl = null;
    this.processManaged = null;
    this.residentPresetId = null;
    this.transitionModelTo('unloaded');
    this.transitionProcessTo('stopped');
  }

  stopForProcessExitSync(): void {
    const child = this.child;
    this.stopping = true;
    if (child?.pid && child.exitCode === null) terminateProcessTree(child.pid);
    this.child = null;
    this.processBaseUrl = null;
    this.processManaged = null;
    this.residentPresetId = null;
    this.transitionModelTo('unloaded');
    this.transitionProcessTo('stopped');
  }

  private spawnProcess(): void {
    this.stopping = false;
    this.startupError = null;
    fs.mkdirSync(path.dirname(this.logPath), { recursive: true });
    fs.writeFileSync(this.logPath, '', 'utf8');
    const configPath = path.resolve(this.engine.WorkingDirectory, this.engine.ConfigPath);
    const child = spawn(this.engine.PythonPath, [this.engine.Entrypoint, '--config', configPath], {
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
      this.transitionProcessTo('failed');
    });
    child.once('exit', (code, signal) => {
      if (this.stopping) return;
      this.startupError = new Error(`TabbyAPI exited unexpectedly (code=${String(code)}, signal=${String(signal)}).`);
      this.processBaseUrl = null;
      this.processManaged = null;
      this.transitionModelTo('unloaded');
      this.transitionProcessTo('failed');
    });
  }

  private async waitForProcess(): Promise<void> {
    const deadline = Date.now() + this.currentPreset.StartupTimeoutMs;
    while (Date.now() < deadline) {
      if (this.startupError) throw this.startupError;
      if (await this.client.isProcessReady(
        getBaseUrl(this.currentPreset),
        this.currentPreset.HealthcheckTimeoutMs,
      )) {
        this.processBaseUrl = getBaseUrl(this.currentPreset);
        this.processManaged = this.shouldManage(this.currentPreset);
        this.transitionProcessTo('ready');
        return;
      }
      await delay(this.currentPreset.HealthcheckIntervalMs);
    }
    this.transitionProcessTo('failed');
    throw new Error('Timed out waiting for the TabbyAPI process.');
  }

  private async loadPreset(preset: ModelRuntimePreset): Promise<void> {
    this.transitionModelTo('loading');
    try {
      const request = new Exl3PresetAdapter(this.engine.ModelRoot).buildLoadRequest(preset);
      await this.client.load(getBaseUrl(preset), request, preset.StartupTimeoutMs);
      this.residentPresetId = preset.id;
      this.transitionModelTo('ready');
    } catch (error) {
      this.transitionModelTo('failed');
      throw error;
    }
  }

  private shouldManage(preset: ModelRuntimePreset): boolean {
    return this.engine.Managed && !preset.ExternalServerEnabled;
  }

  private appendLog(stream: 'stdout' | 'stderr', chunk: string | Buffer): void {
    fs.appendFileSync(this.logPath, `[${stream}] ${String(chunk)}`, 'utf8');
  }
}
