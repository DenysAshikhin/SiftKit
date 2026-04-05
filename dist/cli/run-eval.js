"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runEvalCli = runEvalCli;
const eval_js_1 = require("../eval.js");
const args_js_1 = require("./args.js");
async function runEvalCli(options) {
    const parsed = (0, args_js_1.parseArguments)((0, args_js_1.getCommandArgs)(options.argv));
    const result = await (0, eval_js_1.runEvaluation)({
        FixtureRoot: parsed.fixtureRoot,
        Backend: parsed.backend,
        Model: parsed.model,
    });
    options.stdout.write((0, args_js_1.formatPsList)(result));
    return 0;
}
