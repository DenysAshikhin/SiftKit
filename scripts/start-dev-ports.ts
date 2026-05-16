import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';

export type StartupPortCheck = {
  service: 'status' | 'dashboard';
  name: string;
  host: string;
  port: number;
  fatalIfInUse: boolean;
};

type DashboardPackage = {
  scripts?: {
    dev?: string;
  };
};

function parsePositivePort(rawValue: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(rawValue || String(fallback), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// Wildcard / unspecified addresses are bind-only — they can never be dialed.
const WILDCARD_STATUS_HOSTS = new Set(['0.0.0.0', '::', '[::]', '*']);

/**
 * Address to use when *connecting* to the local status server. Mirrors
 * `getStatusServerConnectHost` in src/lib/status-host.ts — duplicated because
 * tsconfig.scripts.json's `rootDir: scripts` forbids importing from ../src.
 * The status server now binds `0.0.0.0` by default, which is not a dialable
 * target, so it must collapse to loopback for client connections.
 */
export function getStatusServerConnectHost(env: NodeJS.ProcessEnv = process.env): string {
  const configured = (env.SIFTKIT_STATUS_HOST ?? '').trim();
  if (!configured || WILDCARD_STATUS_HOSTS.has(configured)) {
    return '127.0.0.1';
  }
  return configured;
}

function parseCliValue(command: string, optionName: string): string | null {
  const escapedOptionName = optionName.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const match = new RegExp(`(?:^|\\s)--${escapedOptionName}\\s+([^\\s]+)`, 'u').exec(command);
  return match ? match[1] : null;
}

function readDashboardDevScript(dashboardPackageJsonPath: string): string {
  const rawPackage = fs.readFileSync(dashboardPackageJsonPath, 'utf8');
  const parsedPackage = JSON.parse(rawPackage) as DashboardPackage;
  return parsedPackage.scripts?.dev || '';
}

export function buildStartupPortChecks(
  env: NodeJS.ProcessEnv,
  dashboardPackageJsonPath = path.resolve(process.cwd(), 'dashboard', 'package.json'),
): StartupPortCheck[] {
  const dashboardDevScript = readDashboardDevScript(dashboardPackageJsonPath);
  return [
    {
      service: 'status',
      name: 'status server',
      host: getStatusServerConnectHost(env),
      port: parsePositivePort(env.SIFTKIT_STATUS_PORT, 4765),
      fatalIfInUse: true,
    },
    {
      service: 'dashboard',
      name: 'dashboard',
      host: parseCliValue(dashboardDevScript, 'host') || '127.0.0.1',
      port: parsePositivePort(parseCliValue(dashboardDevScript, 'port') || undefined, 6876),
      fatalIfInUse: false,
    },
  ];
}

export function isPortInUse(host: string, port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ host, port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => {
      resolve(false);
    });
    socket.setTimeout(1000, () => {
      socket.destroy();
      resolve(false);
    });
  });
}
