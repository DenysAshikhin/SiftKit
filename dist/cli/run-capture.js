"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runCaptureInternalCli = runCaptureInternalCli;
const interactive_js_1 = require("../interactive.js");
const args_js_1 = require("./args.js");
async function runCaptureInternalCli(options) {
    const parsed = (0, args_js_1.parseArguments)((0, args_js_1.getCommandArgs)(options.argv));
    const command = parsed.command || parsed.positionals[0];
    if (!command) {
        throw new Error('A command is required.');
    }
    const argList = (parsed.argList && parsed.argList.length > 0)
        ? parsed.argList
        : parsed.positionals.slice(1);
    const result = await (0, interactive_js_1.runInteractiveCapture)({
        Command: command,
        ArgumentList: argList,
        Question: parsed.question,
        Format: parsed.format === 'json' ? 'json' : 'text',
        PolicyProfile: parsed.profile || 'general',
        Backend: parsed.backend,
        Model: parsed.model,
    });
    options.stdout.write(`${String(result.OutputText)}\n`);
    return 0;
}
