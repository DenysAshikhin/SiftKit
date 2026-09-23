import { spawn } from 'node:child_process';

import type { Exl3PackageLocator } from '../inference-presets/exl3-model-capabilities.js';
import { InterpreterExl3PackageLocator } from '../inference-presets/exl3-model-capabilities.js';
import { terminateProcessTree } from '../lib/process-tree.js';

/** A managed engine launch; `environment` is the complete child environment, not a delta. */
export type EngineLaunchSpec = {
  readonly command: string;
  readonly args: readonly string[];
  readonly workingDirectory: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
};

/** The slice of a launched engine the runtime observes; a Node `ChildProcess` satisfies it. */
export interface EngineProcess {
  readonly pid?: number | undefined;
  readonly exitCode: number | null;
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
  once(event: 'error', listener: (error: Error) => void): this;
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
}

export interface EngineProcessLauncher {
  launch(spec: EngineLaunchSpec): EngineProcess;
  /** Stops the whole process tree; completion is observed through the process's `exit` event. */
  terminate(engineProcess: EngineProcess): void;
}

/** Everything a managed engine needs from the host machine: its interpreter and its processes. */
export type ManagedEngineHost = {
  readonly launcher: EngineProcessLauncher;
  readonly packageLocator: Exl3PackageLocator;
};

export class ChildProcessEngineLauncher implements EngineProcessLauncher {
  launch(spec: EngineLaunchSpec): EngineProcess {
    return spawn(spec.command, [...spec.args], {
      cwd: spec.workingDirectory,
      env: spec.environment,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }

  terminate(engineProcess: EngineProcess): void {
    if (engineProcess.pid) terminateProcessTree(engineProcess.pid);
  }
}

export function createSystemManagedEngineHost(): ManagedEngineHost {
  return { launcher: new ChildProcessEngineLauncher(), packageLocator: new InterpreterExl3PackageLocator() };
}
