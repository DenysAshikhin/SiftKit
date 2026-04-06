"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getRepoSearchServiceUrl = getRepoSearchServiceUrl;
exports.runRepoSearchCli = runRepoSearchCli;
const index_js_1 = require("../config/index.js");
const http_js_1 = require("../lib/http.js");
const args_js_1 = require("./args.js");
function getRepoSearchServiceUrl() {
    const target = new URL((0, index_js_1.getStatusBackendUrl)());
    target.pathname = '/repo-search';
    target.search = '';
    target.hash = '';
    return target.toString();
}
async function runRepoSearchCli(options) {
    const tokens = (0, args_js_1.getCommandArgs)(options.argv);
    if (tokens.some((token) => token === '-h' || token === '--h' || token === '--help' || token === '-help')) {
        options.stdout.write('Usage: siftkit repo-search --prompt "find x y z in this repo" [--model <model>] [--max-turns <n>] [--log-file <path>]\n'
            + 'Shortcut: siftkit -prompt "find x y z in this repo"\n');
        return 0;
    }
    const parsed = (0, args_js_1.parseArguments)(tokens);
    const prompt = (parsed.prompt || parsed.question || parsed.positionals.join(' ')).trim();
    if (!prompt) {
        throw new Error('A --prompt is required for repo-search.');
    }
    const response = await (0, http_js_1.requestJson)({
        url: getRepoSearchServiceUrl(),
        method: 'POST',
        timeoutMs: 10 * 60 * 1000,
        body: JSON.stringify({
            prompt,
            repoRoot: process.cwd(),
            model: parsed.model,
            maxTurns: parsed.maxTurns,
            logFile: parsed.logFile,
        }),
    });
    const scorecard = response.scorecard && typeof response.scorecard === 'object'
        ? response.scorecard
        : null;
    const finalOutputs = Array.isArray(scorecard?.tasks)
        ? scorecard.tasks
            .map((task) => (typeof task?.finalOutput === 'string' ? task.finalOutput.trim() : ''))
            .filter((value) => value.length > 0)
        : [];
    if (finalOutputs.length > 0) {
        options.stdout.write(`${finalOutputs.join('\n\n')}\n`);
        return 0;
    }
    options.stdout.write(`${JSON.stringify(response.scorecard, null, 2)}\n`);
    return 0;
}
