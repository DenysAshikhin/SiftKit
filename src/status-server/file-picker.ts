import * as path from 'node:path';
import { spawn } from 'node:child_process';

export type ManagedFilePickerTarget = 'managed-llama-executable' | 'managed-llama-model';
export type ManagedFilePickerDialogOptions = {
  title: string;
  filter: string;
  initialPath: string | null;
};
export type ManagedFilePickerResult = {
  cancelled: boolean;
  path: string | null;
};
export type ManagedFileDialogRunner = (options: ManagedFilePickerDialogOptions) => Promise<string | null>;

function toPowerShellSingleQuotedString(value: string): string {
  return `'${String(value).replace(/'/gu, "''")}'`;
}

function buildInitialDirectoryExpression(initialPath: string | null): string {
  if (!initialPath) {
    return '$null';
  }
  const trimmed = initialPath.trim();
  if (!trimmed) {
    return '$null';
  }
  const normalized = path.normalize(trimmed);
  const hasExtension = path.extname(normalized).length > 0;
  const directory = hasExtension ? path.dirname(normalized) : normalized;
  return toPowerShellSingleQuotedString(directory);
}

function buildInitialFileNameExpression(initialPath: string | null): string {
  if (!initialPath) {
    return '$null';
  }
  const trimmed = initialPath.trim();
  if (!trimmed) {
    return '$null';
  }
  const normalized = path.normalize(trimmed);
  return path.extname(normalized).length > 0
    ? toPowerShellSingleQuotedString(path.basename(normalized))
    : '$null';
}

function buildWindowsOpenFileDialogScript(options: ManagedFilePickerDialogOptions): string {
  const initialDirectory = buildInitialDirectoryExpression(options.initialPath);
  const initialFileName = buildInitialFileNameExpression(options.initialPath);
  return [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$dialog = New-Object System.Windows.Forms.OpenFileDialog',
    `$dialog.Title = ${toPowerShellSingleQuotedString(options.title)}`,
    `$dialog.Filter = ${toPowerShellSingleQuotedString(options.filter)}`,
    '$dialog.CheckFileExists = $true',
    '$dialog.Multiselect = $false',
    `$initialDirectory = ${initialDirectory}`,
    'if ($initialDirectory -and (Test-Path -LiteralPath $initialDirectory)) {',
    '  $dialog.InitialDirectory = $initialDirectory',
    '}',
    `$initialFileName = ${initialFileName}`,
    'if ($initialFileName) {',
    '  $dialog.FileName = $initialFileName',
    '}',
    '$result = $dialog.ShowDialog()',
    'if ($result -eq [System.Windows.Forms.DialogResult]::OK) {',
    '  [Console]::Out.Write($dialog.FileName)',
    '}',
  ].join('\n');
}

async function openWindowsFileDialog(options: ManagedFilePickerDialogOptions): Promise<string | null> {
  if (process.platform !== 'win32') {
    throw new Error('Native file picking is only supported on Windows.');
  }
  const script = buildWindowsOpenFileDialogScript(options);
  return await new Promise<string | null>((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-STA', '-Command', script], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if ((code ?? 0) !== 0) {
        reject(new Error(stderr.trim() || `File picker exited with code ${String(code)}`));
        return;
      }
      const selectedPath = stdout.trim();
      resolve(selectedPath ? selectedPath : null);
    });
  });
}

export function getManagedFilePickerDialogOptions(
  target: ManagedFilePickerTarget,
  initialPath: string | null,
): ManagedFilePickerDialogOptions {
  if (target === 'managed-llama-executable') {
    return {
      title: 'Select llama.cpp executable',
      filter: 'Executables (*.exe)|*.exe|All files (*.*)|*.*',
      initialPath,
    };
  }
  return {
    title: 'Select GGUF model',
    filter: 'GGUF models (*.gguf)|*.gguf|All files (*.*)|*.*',
    initialPath,
  };
}

export async function pickManagedFilePath(
  target: ManagedFilePickerTarget,
  initialPath: string | null,
  runner: ManagedFileDialogRunner = openWindowsFileDialog,
): Promise<ManagedFilePickerResult> {
  const selectedPath = await runner(getManagedFilePickerDialogOptions(target, initialPath));
  return {
    cancelled: !selectedPath,
    path: selectedPath,
  };
}
