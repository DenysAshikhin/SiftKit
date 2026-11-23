import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { toError } from '../lib/errors.ts';
import { parseJsonValueText } from '../lib/json.ts';
import { findNearestSiftKitRepoRoot, moduleDirname } from '../lib/paths.ts';
import { z } from '../lib/zod.ts';
import { OWNER_FILE, type RamDisk, type RamDiskDriver } from './ram-disk-cache.ts';

const execFileAsync = promisify(execFile);
type Job = Record<string, string | number>;
// FIND recognises SiftKit's disk by the label CREATE formats it with.
const VOLUME_LABEL = 'SiftKitCache';

/** SiftKit ships its own aim_ll; the Arsenal Image Mounter driver it talks to must be installed. */
export function vendoredAimLlPath(): string {
  const root = findNearestSiftKitRepoRoot(moduleDirname(import.meta.url));
  if (root === null) throw new Error('The SiftKit checkout holding vendor/arsenal-image-mounter was not found.');
  return path.join(root, 'vendor', 'arsenal-image-mounter', 'aim_ll.exe');
}

/** The powershell.exe arguments that run `scriptPath` with its job, as one Start-Process -ArgumentList string. */
export function powerShellFileArguments(scriptPath: string, jobPath: string): string {
  return `-NoProfile -ExecutionPolicy Bypass -File "${scriptPath}" -JobPath "${jobPath}"`;
}

/**
 * A -Command that runs `Start-Process <startArguments>`, waits for that process alone, and exits with its exit code.
 * Not `-Wait`: Windows PowerShell's `-Wait` also waits for every process it leaves running, such as the disk watcher.
 * Reading `Handle` first keeps the exit code readable once the process has exited.
 */
export function startAndWait(startArguments: string): string {
  return `$p = Start-Process ${startArguments} -PassThru; $null = $p.Handle; $p.WaitForExit(); exit $p.ExitCode`;
}

/** The -Command that starts `scriptPath` elevated through UAC and exits with the script's exit code. */
export function elevatedLaunch(scriptPath: string, jobPath: string): string {
  const quoted = powerShellFileArguments(scriptPath, jobPath).replaceAll("'", "''");
  return startAndWait(`powershell -Verb RunAs -WindowStyle Hidden -ArgumentList '${quoted}'`);
}

/** Runs a PowerShell script with a job file; `admin` scripts run elevated, through UAC when this process is not. */
export interface PowerShellRunner {
  /** Returns what the script wrote to its result file. */
  run(script: string, job: Job, admin: boolean): Promise<string>;
}

const FoundSchema = z.object({ disk: z.object({ letter: z.string().regex(/^[A-Z]$/u), sizeBytes: z.number().int().positive() }).nullable() });
const DoneSchema = z.union([z.object({ ok: z.literal(true) }), z.object({ error: z.string() })]);

// Every script reads its job, writes JSON to $job.resultPath (the watcher has none), and reports a thrown error as {"error": ...}.
// It deletes its own job and script files, which the watcher would otherwise leave behind.
const PRELUDE = String.raw`param([string]$JobPath)
$ErrorActionPreference = 'Stop'
$job = Get-Content -Raw -Encoding utf8 $JobPath | ConvertFrom-Json
Remove-Item -Force -LiteralPath $JobPath
function Write-Result($value) { if ($job.resultPath) { ConvertTo-Json -Compress -InputObject $value | Set-Content -Encoding utf8 $job.resultPath } }
# aim_ll writes progress to stderr, which a Stop preference turns into an error, so both streams go to files.
function Invoke-Aim([string[]]$arguments) {
  $log = [IO.Path]::GetTempFileName()
  try {
    $quoted = $arguments | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } }
    $process = Start-Process -FilePath $job.tool -ArgumentList $quoted -NoNewWindow -Wait -PassThru -RedirectStandardOutput $log -RedirectStandardError "$log.err"
    [pscustomobject]@{ Code = $process.ExitCode; Output = @(Get-Content $log) }
  } finally { Remove-Item -Force -ErrorAction SilentlyContinue $log, "$log.err" }
}
try {
`;
const POSTLUDE = String.raw`
} catch { Write-Result @{ error = $_.Exception.Message } }
finally { Remove-Item -Force -ErrorAction SilentlyContinue -LiteralPath $PSCommandPath }
`;

const FIND = String.raw`
  $volume = Get-CimInstance Win32_LogicalDisk -Filter "VolumeName='${VOLUME_LABEL}'" | Select-Object -First 1
  $found = $null
  if ($volume) {
    $partition = Get-CimAssociatedInstance -InputObject $volume -ResultClassName Win32_DiskPartition | Select-Object -First 1
    $drive = if ($partition) { Get-CimAssociatedInstance -InputObject $partition -ResultClassName Win32_DiskDrive | Select-Object -First 1 }
    if ($drive -and $drive.Model -like 'Arsenal Virtual*') { $found = @{ letter = $volume.DeviceID.Substring(0, 1); sizeBytes = [int64]$drive.Size } }
  }
  Write-Result @{ disk = $found }
`;

// The watcher is started (elevated, so no later UAC prompt) before the disk is mounted, so no disk exists without one.
const CREATE = String.raw`
  $root = "$($job.letter):\"
  if (Test-Path $root) { throw "Drive $($job.letter): is already in use." }
  Set-Content -Encoding utf8 -LiteralPath $job.watchScriptPath -Value $job.watchScript
  ConvertTo-Json -Compress -InputObject @{ tool = $job.tool; letter = $job.letter; ownerPid = $job.ownerPid } | Set-Content -Encoding utf8 -LiteralPath $job.watchJobPath
  Start-Process powershell -WindowStyle Hidden -ArgumentList $job.watchArguments
  $code = (Invoke-Aim @('-a', '-t', 'file', '-o', 'awe', '-s', "$($job.sizeBytes)", '-m', "$($job.letter):", '-p', '/fs:ntfs /q /y /v:${VOLUME_LABEL}')).Code
  if ($code -ne 0) { throw "aim_ll -a exited $code." }
  for ($try = 0; $try -lt 40 -and -not (Test-Path $root); $try++) { Start-Sleep -Milliseconds 500 }
  if (-not (Test-Path $root)) { throw "The RAM disk $($job.letter): did not appear." }
  Write-Result @{ ok = $true }
`;

// aim_ll -e names the disk by device number (it rejects -m) and adds -s to the current size.
const GROW = String.raw`
  $unit = $null
  $device = $null
  foreach ($line in (Invoke-Aim @('-l')).Output) {
    if ($line -match 'Device number ([0-9A-Fa-f]{6})') { $device = $Matches[1] }
    if ($line -match "Mounted at $($job.letter):\\") { $unit = $device }
  }
  if (-not $unit) { throw "No Arsenal disk is mounted at $($job.letter):." }
  $current = (Get-Partition -DriveLetter $job.letter | Get-Disk).Size
  $delta = [int64]$job.sizeBytes - $current
  if ($delta -gt 0) {
    $code = (Invoke-Aim @('-e', '-s', "$delta", '-u', $unit)).Code
    if ($code -ne 0) { throw "aim_ll -e exited $code." }
  }
  Update-HostStorageCache
  Resize-Partition -DriveLetter $job.letter -Size (Get-PartitionSupportedSize -DriveLetter $job.letter).SizeMax
  Write-Result @{ ok = $true }
`;

const REMOVE = String.raw`
  $code = (Invoke-Aim @('-d', '-m', "$($job.letter):")).Code
  if ($code -ne 0 -and (Test-Path "$($job.letter):\")) { $code = (Invoke-Aim @('-D', '-m', "$($job.letter):")).Code }
  if (Test-Path "$($job.letter):\") { throw "Could not remove the RAM disk $($job.letter): (aim_ll exit $code)." }
  Write-Result @{ ok = $true }
`;

// Waits for the server that created the disk to exit however it exits, then lets REMOVE run only while the drive is still
// SiftKit's (label) and still that server's (owner file); a later server's disk or another tool's is left alone.
const WATCH_GUARD = String.raw`
  try { Wait-Process -Id $job.ownerPid -ErrorAction Stop } catch {}
  $volume = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='$($job.letter):'"
  if (-not $volume -or $volume.VolumeName -ne '${VOLUME_LABEL}') { return }
  $owner = $null
  try { $owner = (Get-Content -Raw -LiteralPath (Join-Path "$($job.letter):" '${OWNER_FILE}') | ConvertFrom-Json).pid } catch {}
  if ($owner -ne $job.ownerPid) { return }
`;

const script = (body: string): string => `${PRELUDE}${body}${POSTLUDE}`;
export const RAM_DISK_WATCH_SCRIPT = script(`${WATCH_GUARD}${REMOVE}`);
const mounted = (letter: string, sizeBytes: number): RamDisk => ({ letter, root: `${letter}:\\`, sizeBytes });
const tempBase = (): string => path.join(os.tmpdir(), `siftkit-ram-disk-${randomUUID()}`);

/** SiftKit's RAM disk through Arsenal Image Mounter's aim_ll; the disk is NTFS, labelled with VOLUME_LABEL. */
export class ArsenalRamDiskDriver implements RamDiskDriver {
  private readonly runner: PowerShellRunner;
  private readonly aimLlPath: string;

  constructor(runner: PowerShellRunner, aimLlPath: string) {
    this.runner = runner;
    this.aimLlPath = aimLlPath;
  }

  async find(): Promise<RamDisk | null> {
    const found = FoundSchema.parse(parseJsonValueText(await this.runner.run(script(FIND), {}, false))).disk;
    return found === null ? null : mounted(found.letter, found.sizeBytes);
  }

  async create(letter: string, sizeBytes: number, ownerPid: number): Promise<RamDisk> {
    const base = tempBase();
    const watch = { script: `${base}.watch.ps1`, job: `${base}.watch.json` };
    await this.admin('create', CREATE, {
      letter, sizeBytes, ownerPid, watchScript: RAM_DISK_WATCH_SCRIPT, watchScriptPath: watch.script, watchJobPath: watch.job,
      watchArguments: powerShellFileArguments(watch.script, watch.job),
    });
    return mounted(letter, sizeBytes);
  }

  async grow(disk: RamDisk, sizeBytes: number): Promise<RamDisk> {
    await this.admin('grow', GROW, { letter: disk.letter, sizeBytes });
    return { ...disk, sizeBytes };
  }

  async remove(disk: RamDisk): Promise<void> {
    await this.admin('remove', REMOVE, { letter: disk.letter });
  }

  /** Checks aim_ll first, so a missing copy fails before the UAC prompt rather than inside the elevated script. */
  private async admin(operation: string, body: string, job: Job): Promise<void> {
    if (!fs.existsSync(this.aimLlPath)) throw new Error(`aim_ll was not found at ${this.aimLlPath}.`);
    const done = DoneSchema.parse(parseJsonValueText(await this.runner.run(script(body), { tool: this.aimLlPath, ...job }, true)));
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
        ? ['-NoProfile', '-Command', elevatedLaunch(files.script, files.job)]
        :['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', files.script, '-JobPath', files.job];
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
