import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { toError } from '../lib/errors.ts';
import { parseJsonValueText } from '../lib/json.ts';
import { z } from '../lib/zod.ts';
import type { RamDisk, RamDiskDriver } from './ram-disk-cache.ts';

const execFileAsync = promisify(execFile);
type Job = Record<string, string | number>;

/** Runs a PowerShell script with a job file; `admin` scripts run elevated, through UAC when this process is not. */
export interface PowerShellRunner {
  /** Returns what the script wrote to its result file. */
  run(script: string, job: Job, admin: boolean): Promise<string>;
  /** Starts an admin script without waiting, for the process-exit path. */
  start(script: string, job: Job): void;
}

const FoundSchema = z.object({ disk: z.object({ letter: z.string().regex(/^[A-Z]$/u), sizeBytes: z.number().int().positive() }).nullable() });
const DoneSchema = z.union([z.object({ ok: z.literal(true) }), z.object({ error: z.string() })]);

// Every script reads its job, writes JSON to $job.resultPath (a detached run has none), and reports a thrown error as {"error": ...}.
// It deletes its own job and script files, which a detached run would otherwise leave behind.
const PRELUDE = String.raw`param([string]$JobPath)
$ErrorActionPreference = 'Stop'
$job = Get-Content -Raw -Encoding utf8 $JobPath | ConvertFrom-Json
Remove-Item -Force -LiteralPath $JobPath
function Write-Result($value) { if ($job.resultPath) { ConvertTo-Json -Compress -InputObject $value | Set-Content -Encoding utf8 $job.resultPath } }
# aim_ll writes progress to stderr, so it runs through Start-Process with both streams to files (as smol-helper does).
function Invoke-Aim([string[]]$arguments) {
  $log = [IO.Path]::GetTempFileName()
  try {
    $quoted = $arguments | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } }
    $process = Start-Process -FilePath $job.tool -ArgumentList $quoted -NoNewWindow -Wait -PassThru -RedirectStandardOutput $log -RedirectStandardError "$log.err"
    $process.ExitCode
  } finally { Remove-Item -Force -ErrorAction SilentlyContinue $log, "$log.err" }
}
try {
`;
const POSTLUDE = String.raw`
} catch { Write-Result @{ error = $_.Exception.Message } }
finally { Remove-Item -Force -ErrorAction SilentlyContinue -LiteralPath $PSCommandPath }
`;

const FIND = String.raw`
  $volume = Get-CimInstance Win32_LogicalDisk -Filter "VolumeName='SiftKitCache'" | Select-Object -First 1
  $found = $null
  if ($volume) {
    $partition = Get-CimAssociatedInstance -InputObject $volume -ResultClassName Win32_DiskPartition | Select-Object -First 1
    $drive = if ($partition) { Get-CimAssociatedInstance -InputObject $partition -ResultClassName Win32_DiskDrive | Select-Object -First 1 }
    if ($drive -and $drive.Model -like 'Arsenal Virtual*') { $found = @{ letter = $volume.DeviceID.Substring(0, 1); sizeBytes = [int64]$drive.Size } }
  }
  Write-Result @{ disk = $found }
`;

const CREATE = String.raw`
  $root = "$($job.letter):\"
  if (Test-Path $root) { throw "Drive $($job.letter): is already in use." }
  $code = Invoke-Aim @('-a', '-t', 'file', '-o', 'awe', '-s', "$($job.sizeBytes)", '-m', "$($job.letter):", '-p', '/fs:ntfs /q /y /v:SiftKitCache')
  if ($code -ne 0) { throw "aim_ll -a exited $code." }
  for ($try = 0; $try -lt 40 -and -not (Test-Path $root); $try++) { Start-Sleep -Milliseconds 500 }
  if (-not (Test-Path $root)) { throw "The RAM disk $($job.letter): did not appear." }
  Write-Result @{ ok = $true }
`;

const GROW = String.raw`
  $code = Invoke-Aim @('-e', '-s', "$($job.sizeBytes)", '-m', "$($job.letter):")
  if ($code -ne 0) { throw "aim_ll -e exited $code." }
  Update-HostStorageCache
  Resize-Partition -DriveLetter $job.letter -Size (Get-PartitionSupportedSize -DriveLetter $job.letter).SizeMax
  Write-Result @{ ok = $true }
`;

const REMOVE = String.raw`
  $code = Invoke-Aim @('-d', '-m', "$($job.letter):")
  if ($code -ne 0 -and (Test-Path "$($job.letter):\")) { $code = Invoke-Aim @('-D', '-m', "$($job.letter):") }
  if (Test-Path "$($job.letter):\") { throw "Could not remove the RAM disk $($job.letter): (aim_ll exit $code)." }
  Write-Result @{ ok = $true }
`;

const script = (body: string): string => `${PRELUDE}${body}${POSTLUDE}`;
const mounted = (letter: string, sizeBytes: number): RamDisk => ({ letter, root: `${letter}:\\`, sizeBytes });
const tempBase = (): string => path.join(os.tmpdir(), `siftkit-ram-disk-${randomUUID()}`);

/** SiftKit's RAM disk through Arsenal Image Mounter's aim_ll; the disk is NTFS, labelled SiftKitCache. */
export class ArsenalRamDiskDriver implements RamDiskDriver {
  private readonly runner: PowerShellRunner;

  constructor(runner: PowerShellRunner) {
    this.runner = runner;
  }

  async find(): Promise<RamDisk | null> {
    const found = FoundSchema.parse(parseJsonValueText(await this.runner.run(script(FIND), {}, false))).disk;
    return found === null ? null : mounted(found.letter, found.sizeBytes);
  }

  async create(toolPath: string, letter: string, sizeBytes: number): Promise<RamDisk> {
    await this.admin('create', CREATE, { tool: toolPath, letter, sizeBytes });
    return mounted(letter, sizeBytes);
  }

  async grow(toolPath: string, disk: RamDisk, sizeBytes: number): Promise<RamDisk> {
    await this.admin('grow', GROW, { tool: toolPath, letter: disk.letter, sizeBytes });
    return { ...disk, sizeBytes };
  }

  async remove(toolPath: string, disk: RamDisk): Promise<void> {
    await this.admin('remove', REMOVE, { tool: toolPath, letter: disk.letter });
  }

  removeDetached(toolPath: string, disk: RamDisk): void {
    this.runner.start(script(REMOVE), { tool: toolPath, letter: disk.letter });
  }

  private async admin(operation: string, body: string, job: Job): Promise<void> {
    const done = DoneSchema.parse(parseJsonValueText(await this.runner.run(script(body), job, true)));
    if ('error' in done) throw new Error(`RAM disk ${operation} failed: ${done.error}`);
  }
}

/** Writes the script and its job to the temp directory and runs it, elevated through UAC when it must be. */
export class SystemPowerShellRunner implements PowerShellRunner {
  private elevated: boolean | null = null;

  async run(script: string, job: Job, admin: boolean): Promise<string> {
    const base = tempBase();
    const result = `${base}.result.json`;
    const files = this.write(base, script, { ...job, resultPath: result });
    try {
      const elevate = admin && !await this.isElevated();
      // A declined UAC prompt makes Start-Process throw, so the outer PowerShell exits non-zero.
      const args = elevate
        ? ['-NoProfile', '-Command', `$p = Start-Process powershell -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File "${files.script}" -JobPath "${files.job}"'; exit $p.ExitCode`]
        : ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', files.script, '-JobPath', files.job];
      try {
        await execFileAsync('powershell.exe', args, { windowsHide: true });
      } catch (error) {
        if (!fs.existsSync(result)) throw new Error(`The RAM disk script did not run: ${toError(error).message}`);
      }
      if (!fs.existsSync(result)) throw new Error('The RAM disk script wrote no result.');
      return fs.readFileSync(result, 'utf8');
    } finally {
      // The script deletes its own files; one that never ran (a declined UAC prompt) leaves them here.
      for (const file of [files.script, files.job, result]) fs.rmSync(file, { force: true });
    }
  }

  start(script: string, job: Job): void {
    const files = this.write(tempBase(), script, job);
    const child = spawn('powershell.exe', ['-NoProfile', '-Command',
      `Start-Process powershell -Verb RunAs -WindowStyle Hidden -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File "${files.script}" -JobPath "${files.job}"'`],
    { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
  }

  private write(base: string, script: string, job: Job): { script: string; job: string } {
    const files = { script: `${base}.ps1`, job: `${base}.json` };
    fs.writeFileSync(files.script, script, 'utf8');
    fs.writeFileSync(files.job, JSON.stringify(job), 'utf8');
    return files;
  }

  private async isElevated(): Promise<boolean> {
    if (this.elevated === null) {
      const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-Command',
        '([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)'],
      { windowsHide: true });
      this.elevated = stdout.trim() === 'True';
    }
    return this.elevated;
  }
}
