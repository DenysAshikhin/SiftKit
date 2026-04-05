"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runFindFiles = runFindFiles;
const find_files_js_1 = require("../find-files.js");
const args_js_1 = require("./args.js");
async function runFindFiles(options) {
    const parsed = (0, args_js_1.parseArguments)((0, args_js_1.getCommandArgs)(options.argv));
    if (parsed.positionals.length === 0) {
        throw new Error('At least one file name or pattern is required.');
    }
    const results = (0, find_files_js_1.findFiles)(parsed.positionals, parsed.path || '.');
    for (const result of results) {
        options.stdout.write(`${parsed.fullPath ? result.FullPath : result.RelativePath}\n`);
    }
    return 0;
}
