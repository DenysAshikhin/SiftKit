"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runSummary = runSummary;
const summary_js_1 = require("../summary.js");
const args_js_1 = require("./args.js");
async function runSummary(options) {
    const parsed = (0, args_js_1.parseArguments)((0, args_js_1.getCommandArgs)(options.argv));
    const question = parsed.question || parsed.positionals[0];
    if (!question) {
        throw new Error('A question is required.');
    }
    const inputText = (0, summary_js_1.readSummaryInput)({
        text: parsed.text,
        file: parsed.file,
        stdinText: options.stdinText,
    });
    if ((!parsed.file || parsed.file.length === 0) && !inputText?.trim()) {
        throw new Error('stdin, --text or --file required');
    }
    const result = await (0, summary_js_1.summarizeRequest)({
        question,
        inputText: inputText ?? '',
        format: parsed.format === 'json' ? 'json' : 'text',
        policyProfile: parsed.profile || 'general',
        backend: parsed.backend,
        model: parsed.model,
        sourceKind: process.env.SIFTKIT_SUMMARY_SOURCE_KIND === 'command-output' || Boolean(options.stdinText?.trim())
            ? 'command-output'
            : 'standalone',
        commandExitCode: process.env.SIFTKIT_SUMMARY_COMMAND_EXIT_CODE?.trim()
            ? Number.parseInt(process.env.SIFTKIT_SUMMARY_COMMAND_EXIT_CODE, 10)
            : undefined,
    });
    options.stdout.write(`${result.Summary}\n`);
    return 0;
}
