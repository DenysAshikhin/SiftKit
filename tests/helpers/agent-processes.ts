import { randomInt } from 'node:crypto';
import { spawnSync } from 'node:child_process';

import { z } from 'zod';

const CountSchema = z.coerce.number().int().nonnegative();

/** A loopback address no other test uses; pings to it are the processes a test may leave behind. */
export function agentProcessMarker(): string {
  return `127.${randomInt(1, 255)}.${randomInt(1, 255)}.${randomInt(2, 255)}`;
}

/** Starts a detached child and an orphaned grandchild, both outliving the command unless contained. */
export function leaveProcessesCommand(marker: string): string {
  return `Start-Process -WindowStyle Hidden ping.exe -ArgumentList '-n','120','${marker}'; `
    + `Start-Process -WindowStyle Hidden cmd.exe -ArgumentList '/c','start /b ping -n 120 ${marker} >nul'`;
}

function queryMarked(marker: string, action: string): string {
  const filter = `Get-CimInstance Win32_Process -Filter "Name='PING.EXE'" | Where-Object { $_.CommandLine -like '*${marker}*' }`;
  return spawnSync('powershell.exe', ['-NoProfile', '-Command', `@(${filter})${action}`], { encoding: 'utf8' }).stdout.trim();
}

export function countMarkedProcesses(marker: string): number {
  return CountSchema.parse(queryMarked(marker, '.Count'));
}

export function killMarkedProcesses(marker: string): void {
  queryMarked(marker, ' | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }');
}
