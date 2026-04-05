"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runCommandCli = runCommandCli;
const command_js_1 = require("../command.js");
const args_js_1 = require("./args.js");
async function runCommandCli(options) {
    const parsed = (0, args_js_1.parseArguments)((0, args_js_1.getCommandArgs)(options.argv));
    const command = parsed.command || parsed.positionals[0];
    if (!command) {
        throw new Error('A command is required.');
    }
    const argList = (parsed.argList && parsed.argList.length > 0)
        ? parsed.argList
        : parsed.positionals.slice(1);
    const result = await (0, command_js_1.runCommand)({
        Command: command,
        ArgumentList: argList,
        Question: parsed.question,
        RiskLevel: parsed.risk,
        ReducerProfile: parsed.reducer,
        Format: parsed.format === 'json' ? 'json' : 'text',
        PolicyProfile: parsed.profile || 'general',
        Backend: parsed.backend,
        Model: parsed.model,
    });
    if (result.Summary) {
        options.stdout.write(`${result.Summary}\n`);
    }
    else {
        options.stdout.write('No summary generated.\n');
    }
    options.stdout.write(`Raw log: ${result.RawLogPath}\n`);
    return 0;
}
