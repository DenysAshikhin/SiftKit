import { basename, dirname, extname, normalize } from 'node:path';
import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import type { ManagedFilePickerTarget } from '@siftkit/contracts';

/** A folder dialog returns a directory; a file dialog filters with an OpenFileDialog filter. */
export type ManagedFilePickerDialogOptions =
  | { kind: 'folder'; title: string; initialPath: string | null }
  | { kind: 'file'; title: string; filter: string; initialPath: string | null };
type FileDialogOptions = Extract<ManagedFilePickerDialogOptions, { kind: 'file' }>;
type FolderDialogOptions = Extract<ManagedFilePickerDialogOptions, { kind: 'folder' }>;
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

/** File name pre-filled in the folder dialog; accepting it inside a folder selects that folder. */
export const MODEL_FOLDER_PLACEHOLDER = 'Select folder';

/** Explorer dialog that accepts either a folder (via the placeholder) or any file inside one. */
export function buildWindowsFolderOrFileDialogScript(options: FolderDialogOptions): string {
  const initialDirectory = buildInitialDirectoryExpression(options.initialPath);
  return [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$dialog = New-Object System.Windows.Forms.OpenFileDialog',
    `$dialog.Title = ${toPowerShellSingleQuotedString(options.title)}`,
    "$dialog.Filter = 'All files (*.*)|*.*'",
    '$dialog.ValidateNames = $false',
    '$dialog.CheckFileExists = $false',
    '$dialog.CheckPathExists = $true',
    '$dialog.Multiselect = $false',
    `$dialog.FileName = ${toPowerShellSingleQuotedString(MODEL_FOLDER_PLACEHOLDER)}`,
    `$initialDirectory = ${initialDirectory}`,
    'if ($initialDirectory -and (Test-Path -LiteralPath $initialDirectory)) {',
    '  $dialog.InitialDirectory = $initialDirectory',
    '}',
    '$result = $dialog.ShowDialog()',
    'if ($result -eq [System.Windows.Forms.DialogResult]::OK) {',
    '  [Console]::Out.Write($dialog.FileName)',
    '}',
  ].join('\n');
}

/** A picked directory is kept; a picked file or the placeholder resolves to its folder. */
function resolveSelectedDirectory(selectedPath: string): string {
  return existsSync(selectedPath) && statSync(selectedPath).isDirectory() ? selectedPath : dirname(selectedPath);
}

function buildWindowsOpenFileDialogScript(options: FileDialogOptions): string {
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
  const script = options.kind === 'folder'
    ? buildWindowsFolderOrFileDialogScript(options)
    : buildWindowsOpenFileDialogScript(options);
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
    return { kind: 'folder', title: 'Select EXL3 model directory', initialPath };
  }
  return {
    kind: 'file',
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
  const options = getManagedFilePickerDialogOptions(target, initialPath);
  const selectedPath = await runner(options);
  if (!selectedPath) return { cancelled: true, path: null };
  return { cancelled: false, path: options.kind === 'folder' ? resolveSelectedDirectory(selectedPath) : selectedPath };
}
