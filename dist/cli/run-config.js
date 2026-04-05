"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runConfigGet = runConfigGet;
exports.runConfigSet = runConfigSet;
const config_js_1 = require("../config.js");
const args_js_1 = require("./args.js");
async function runConfigGet(stdout) {
    const config = await (0, config_js_1.loadConfig)({ ensure: true });
    stdout.write(`${JSON.stringify(config, null, 2)}\n`);
    return 0;
}
async function runConfigSet(options) {
    const parsed = (0, args_js_1.parseArguments)((0, args_js_1.getCommandArgs)(options.argv));
    if (!parsed.key) {
        throw new Error('A --key is required.');
    }
    const config = await (0, config_js_1.setTopLevelConfigKey)(parsed.key, parsed.value ?? null);
    options.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
    return 0;
}
