import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';

export type StartupPortCheck = {
  name: string;
  host: string;
  port: number;
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
      name: 'status server',
      host: env.SIFTKIT_STATUS_HOST || '127.0.0.1',
      port: parsePositivePort(env.SIFTKIT_STATUS_PORT, 4765),
    },
    {
      name: 'dashboard',
      host: parseCliValue(dashboardDevScript, 'host') || '127.0.0.1',
      port: parsePositivePort(parseCliValue(dashboardDevScript, 'port') || undefined, 6876),
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
