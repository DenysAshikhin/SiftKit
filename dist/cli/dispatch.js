"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runCli = runCli;
const index_js_1 = require("../config/index.js");
const args_js_1 = require("./args.js");
const help_js_1 = require("./help.js");
const run_capture_js_1 = require("./run-capture.js");
const run_command_js_1 = require("./run-command.js");
const run_config_js_1 = require("./run-config.js");
const run_eval_js_1 = require("./run-eval.js");
const run_find_files_js_1 = require("./run-find-files.js");
const run_install_js_1 = require("./run-install.js");
const run_internal_js_1 = require("./run-internal.js");
const run_repo_search_js_1 = require("./run-repo-search.js");
const run_summary_js_1 = require("./run-summary.js");
const run_test_js_1 = require("./run-test.js");
async function runCli(options) {
    const stdout = options.stdout || process.stdout;
    const stderr = options.stderr || process.stderr;
    if (options.argv.length === 0 || ['help', '--help', '--h', '-h', '-help'].includes(options.argv[0])) {
        (0, help_js_1.showHelp)(stdout);
        return 0;
    }
    const commandName = (0, args_js_1.getCommandName)(options.argv);
    if (args_js_1.BLOCKED_PUBLIC_COMMANDS.has(options.argv[0])) {
        stderr.write(`Command '${options.argv[0]}' is not exposed in this CLI build. Available commands: summary, repo-search, help.\n`);
        return 1;
    }
    const commandArgs = (0, args_js_1.getCommandArgs)(options.argv);
    const commandHelpRequested = commandArgs.some((token) => token === '-h' || token === '--h' || token === '--help' || token === '-help');
    try {
        if (commandName === 'repo-search') {
            (0, args_js_1.validateRepoSearchTokens)(commandArgs);
        }
        if (commandName === 'repo-search' && commandHelpRequested) {
            return await (0, run_repo_search_js_1.runRepoSearchCli)({ argv: options.argv, stdout });
        }
        if (args_js_1.SERVER_DEPENDENT_COMMANDS.has(commandName)) {
            await (0, index_js_1.ensureStatusServerReachable)();
        }
        switch (commandName) {
            case 'summary':
                return await (0, run_summary_js_1.runSummary)({ argv: options.argv, stdinText: options.stdinText, stdout });
            case 'install':
                return await (0, run_install_js_1.runInstall)(stdout);
            case 'config-get':
                return await (0, run_config_js_1.runConfigGet)(stdout);
            case 'config-set':
                return await (0, run_config_js_1.runConfigSet)({ argv: options.argv, stdout });
            case 'run':
                return await (0, run_command_js_1.runCommandCli)({ argv: options.argv, stdout });
            case 'eval':
                return await (0, run_eval_js_1.runEvalCli)({ argv: options.argv, stdout });
            case 'codex-policy':
                return await (0, run_install_js_1.runCodexPolicyCli)({ argv: options.argv, stdout });
            case 'install-global':
                return await (0, run_install_js_1.runInstallGlobalCli)({ argv: options.argv, stdout });
            case 'capture-internal':
                return await (0, run_capture_js_1.runCaptureInternalCli)({ argv: options.argv, stdout });
            case 'repo-search':
                return await (0, run_repo_search_js_1.runRepoSearchCli)({ argv: options.argv, stdout });
            case 'find-files':
                return await (0, run_find_files_js_1.runFindFiles)({ argv: options.argv, stdout });
            case 'test':
                return await (0, run_test_js_1.runTest)(stdout);
            case 'internal':
                return await (0, run_internal_js_1.runInternal)({ argv: options.argv, stdout });
            default:
                return 127;
        }
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        stderr.write(`${message}\n`);
        return 1;
    }
}
