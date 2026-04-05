"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runInstall = runInstall;
exports.runCodexPolicyCli = runCodexPolicyCli;
exports.runInstallGlobalCli = runInstallGlobalCli;
const install_js_1 = require("../install.js");
const args_js_1 = require("./args.js");
async function runInstall(stdout) {
    const result = await (0, install_js_1.installSiftKit)(false);
    stdout.write((0, args_js_1.formatPsList)(result));
    return 0;
}
async function runCodexPolicyCli(options) {
    const parsed = (0, args_js_1.parseArguments)((0, args_js_1.getCommandArgs)(options.argv));
    const result = await (0, install_js_1.installCodexPolicy)(parsed.codexHome);
    options.stdout.write((0, args_js_1.formatPsList)(result));
    return 0;
}
async function runInstallGlobalCli(options) {
    const parsed = (0, args_js_1.parseArguments)((0, args_js_1.getCommandArgs)(options.argv));
    const result = await (0, install_js_1.installShellIntegration)({
        BinDir: parsed.binDir,
        ModuleInstallRoot: parsed.moduleRoot,
    });
    options.stdout.write((0, args_js_1.formatPsList)(result));
    return 0;
}
