"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runCli = void 0;
const dispatch_js_1 = require("./cli/dispatch.js");
Object.defineProperty(exports, "runCli", { enumerable: true, get: function () { return dispatch_js_1.runCli; } });
if (require.main === module) {
    void (async () => {
        let stdinText = '';
        if (!process.stdin.isTTY) {
            stdinText = await new Promise((resolve, reject) => {
                let collected = '';
                process.stdin.setEncoding('utf8');
                process.stdin.on('data', (chunk) => {
                    collected += chunk;
                });
                process.stdin.on('end', () => resolve(collected));
                process.stdin.on('error', reject);
            });
        }
        const exitCode = await (0, dispatch_js_1.runCli)({
            argv: process.argv.slice(2),
            stdinText,
        });
        process.exit(exitCode);
    })();
}
