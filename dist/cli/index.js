"use strict";
// CLI module public API barrel.
Object.defineProperty(exports, "__esModule", { value: true });
exports.runCli = void 0;
var dispatch_js_1 = require("./dispatch.js");
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
        const { runCli: run } = await import('./dispatch.js');
        const exitCode = await run({
            argv: process.argv.slice(2),
            stdinText,
        });
        process.exit(exitCode);
    })();
}
