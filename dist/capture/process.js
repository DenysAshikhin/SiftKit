"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.invokeProcess = invokeProcess;
exports.quoteForPowerShell = quoteForPowerShell;
exports.captureWithTranscript = captureWithTranscript;
const node_child_process_1 = require("node:child_process");
const command_path_js_1 = require("./command-path.js");
function invokeProcess(command, argumentList = []) {
    const runChild = (executable, shell) => (0, node_child_process_1.spawnSync)(executable, argumentList, {
        encoding: 'utf8',
        shell,
        windowsHide: true,
        cwd: process.cwd(),
    });
    let result = runChild(command, false);
    if (result.error && /ENOENT/iu.test(result.error.message || '')) {
        try {
            result = runChild((0, command_path_js_1.resolveExternalCommand)(command), false);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return {
                ExitCode: 1,
                StdOut: '',
                StdErr: message,
                Combined: message,
            };
        }
    }
    if (result.error && /EPERM|EACCES/iu.test(result.error.message || '')) {
        result = runChild(command, true);
    }
    const stdout = result.stdout || '';
    const stderr = `${result.stderr || ''}${result.error ? `${result.stderr ? '\n' : ''}${result.error.message}` : ''}`;
    return {
        ExitCode: typeof result.status === 'number' ? result.status : 1,
        StdOut: stdout,
        StdErr: stderr,
        Combined: `${stdout}${stdout && stderr ? '\n' : ''}${stderr}`.trim(),
    };
}
function quoteForPowerShell(value) {
    return `'${value.replace(/'/gu, "''")}'`;
}
function captureWithTranscript(commandPath, argumentList, transcriptPath) {
    const joinedArgs = argumentList.map((entry) => quoteForPowerShell(entry)).join(', ');
    const script = [
        "$ErrorActionPreference = 'Stop'",
        `$transcriptPath = ${quoteForPowerShell(transcriptPath)}`,
        `$commandPath = ${quoteForPowerShell(commandPath)}`,
        `Start-Transcript -Path $transcriptPath -Force | Out-Null`,
        'try {',
        `  & $commandPath @(${joinedArgs})`,
        '  if ($null -ne $LASTEXITCODE) { exit [int]$LASTEXITCODE }',
        '  exit 0',
        '} finally {',
        '  try { Stop-Transcript | Out-Null } catch {}',
        '}',
    ].join('\n');
    const result = (0, node_child_process_1.spawnSync)('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
        encoding: 'utf8',
        stdio: 'ignore',
        windowsHide: false,
    });
    return typeof result.status === 'number' ? result.status : 1;
}
