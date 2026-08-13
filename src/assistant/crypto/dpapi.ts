import { spawnPowerShellAsync } from '../../lib/powershell.js';

/**
 * Windows DPAPI (`CurrentUser` scope) via PowerShell — the same protection the desktop shell uses
 * for the evidence key at rest. Payloads travel as base64 on the command line, so this is for key
 * material and other small secrets, never for evidence bytes.
 */

/** Raised when DPAPI cannot unprotect — wrong machine or user, or corrupt bytes. */
export class DpapiUnavailableError extends Error {}

const DPAPI_TIMEOUT_MS = 30_000;

async function runProtectedData(
  operation: 'Protect' | 'Unprotect',
  data: Buffer,
): Promise<Buffer> {
  const command = [
    'Add-Type -AssemblyName System.Security;',
    `[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::${operation}(`,
    `[Convert]::FromBase64String('${data.toString('base64')}'), $null,`,
    "[Security.Cryptography.DataProtectionScope]::CurrentUser))",
  ].join(' ');

  const result = await spawnPowerShellAsync(command, { timeoutMs: DPAPI_TIMEOUT_MS });
  if (result.exitCode !== 0) {
    throw new DpapiUnavailableError(`DPAPI ${operation} failed: ${result.output.trim()}`);
  }
  // The host may wrap long output, so whitespace is stripped rather than lines being picked.
  const encoded = result.stdout.replace(/\s+/gu, '');
  if (encoded.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) {
    throw new DpapiUnavailableError(`DPAPI ${operation} produced no usable output.`);
  }
  return Buffer.from(encoded, 'base64');
}

export async function dpapiProtect(data: Buffer): Promise<Buffer> {
  return runProtectedData('Protect', data);
}

export async function dpapiUnprotect(data: Buffer): Promise<Buffer> {
  return runProtectedData('Unprotect', data);
}
