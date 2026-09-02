import { basename, dirname, extname, normalize } from 'node:path';
import { spawn } from 'node:child_process';
import type { ManagedFilePickerTarget } from '@siftkit/contracts';

export type ManagedFilePickerDialogOptions = {
  title: string;
  /** OpenFileDialog filter; null opens a directory picker instead. */
  filter: string | null;
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
  const normalized = normalize(trimmed);
  const hasExtension = extname(normalized).length > 0;
  const directory = hasExtension ? dirname(normalized) : normalized;
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
  const normalized = normalize(trimmed);
  return extname(normalized).length > 0
    ? toPowerShellSingleQuotedString(basename(normalized))
    : '$null';
}

function buildWindowsFolderDialogScript(options: ManagedFilePickerDialogOptions): string {
  const initialDirectory = buildInitialDirectoryExpression(options.initialPath);
  return [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
    `$dialog.Description = ${toPowerShellSingleQuotedString(options.title)}`,
    '$dialog.ShowNewFolderButton = $false',
    `$initialDirectory = ${initialDirectory}`,
    'if ($initialDirectory -and (Test-Path -LiteralPath $initialDirectory)) {',
    '  $dialog.SelectedPath = $initialDirectory',
    '}',
    '$result = $dialog.ShowDialog()',
    'if ($result -eq [System.Windows.Forms.DialogResult]::OK) {',
    '  [Console]::Out.Write($dialog.SelectedPath)',
    '}',
  ].join('\n');
}

function buildWindowsOpenFileDialogScript(options: ManagedFilePickerDialogOptions, filter: string): string {
  const initialDirectory = buildInitialDirectoryExpression(options.initialPath);
  const initialFileName = buildInitialFileNameExpression(options.initialPath);
  return [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$dialog = New-Object System.Windows.Forms.OpenFileDialog',
    `$dialog.Title = ${toPowerShellSingleQuotedString(options.title)}`,
    `$dialog.Filter = ${toPowerShellSingleQuotedString(filter)}`,
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
  const script = options.filter === null
    ? buildWindowsFolderDialogScript(options)
    : buildWindowsOpenFileDialogScript(options, options.filter);
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
  if (target === 'model-preset-path') {
    return {
      title: 'Select EXL3 model directory',
      filter: null,
      initialPath,
    };
  }
  return {
    title: 'Select autoload file',
    filter: 'Markdown (*.md)|*.md|Text (*.txt)|*.txt|All files (*.*)|*.*',
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
