#!/usr/bin/env node
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_child_process_1 = require("node:child_process");
const verbose = process.argv.includes('--verbose');
const timeoutArg = process.argv.find((a) => a.startsWith('--timeout-sec='));
const timeoutSec = timeoutArg ? Number(timeoutArg.split('=')[1]) : 180;
const timeoutMs = Number.isFinite(timeoutSec) && timeoutSec > 0 ? timeoutSec * 1000 : 180000;
function runTsx(args) {
    const display = `tsx ${args.join(' ')}`;
    console.log(`\n>>> ${display}`);
    const result = (0, node_child_process_1.spawnSync)('npx', ['tsx', ...args], {
        encoding: 'utf8',
        timeout: timeoutMs,
        windowsHide: true,
        shell: false,
    });
    let output = `${result.stdout || ''}${result.stderr || ''}`;
    if (result.error) {
        output += `\nFAILED TO START COMMAND: ${result.error.message}\n`;
    }
    output = output.trimEnd();
    if (verbose) {
        if (output.length > 0)
            console.log(output);
    }
    else {
        const lines = output.split(/\r?\n/).filter(Boolean);
        const tail = lines.slice(-40);
        if (tail.length > 0)
            console.log(tail.join('\n'));
    }
    let exitCode = typeof result.status === 'number' ? result.status : 1;
    if (result.signal === 'SIGTERM' && result.error && 'code' in result.error && result.error.code === 'ETIMEDOUT') {
        console.log(`COMMAND TIMED OUT AFTER ${Math.floor(timeoutMs / 1000)} SECONDS`);
        exitCode = 124;
    }
    return { output, exitCode };
}
function testCasePassedInTap(output, testName) {
    const escaped = testName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const notOk = new RegExp(`^\\s*not ok\\s+\\d+\\s+-\\s+${escaped}\\s*$`, 'm');
    if (notOk.test(output))
        return false;
    const ok = new RegExp(`^\\s*ok\\s+\\d+\\s+-\\s+${escaped}\\s*$`, 'm');
    return ok.test(output);
}
const runtimeSummarizeResult = runTsx(['--test', '--test-reporter=tap', 'tests/runtime-summarize.test.js',
    '--test-name-pattern', 'summary below planner threshold|summary above planner threshold|summary retries with smaller chunks|summary resizes llama.cpp chunks|command-output never surfaces unsupported_input']);
const repoCliResult = runTsx([
    '--test',
    '--test-reporter=tap',
    'tests/repo-search-cli.test.ts',
    '--test-name-pattern',
    'repo-search delegates execution to status server',
]);
const repoLoopResult = runTsx([
    '--test',
    '--test-reporter=tap',
    'tests/mock-repo-search-loop.test.ts',
    '--test-name-pattern',
    'runTaskLoop sends append-only chat requests with explicit cache_prompt and a pinned slot',
]);
const dashboardResult = runTsx([
    '--test',
    '--test-reporter=tap',
    'tests/dashboard-status-server.test.ts',
    '--test-name-pattern',
    'chat completion receives hidden tool context while keeping it out of visible chat history',
]);
const cases = [
    {
        id: 'V1',
        description: 'Summary below planner threshold -> one-shot non-thinking',
        passed: testCasePassedInTap(runtimeSummarizeResult.output, 'summary below planner threshold runs one-shot with forced non-thinking'),
    },
    {
        id: 'V2',
        description: 'Summary above planner threshold -> planner mode',
        passed: testCasePassedInTap(runtimeSummarizeResult.output, 'summary above planner threshold uses planner flow without forced non-thinking override'),
    },
    {
        id: 'V3a',
        description: 'Oversized summary -> retry smaller chunks on llama 400',
        passed: testCasePassedInTap(runtimeSummarizeResult.output, 'summary retries with smaller chunks when llama.cpp rejects an oversized prompt and tokenization is unavailable'),
    },
    {
        id: 'V3b',
        description: 'Oversized summary -> preflight chunk resize before first chat',
        passed: testCasePassedInTap(runtimeSummarizeResult.output, 'summary resizes llama.cpp chunks before the first chat request when prompt tokenization exceeds context'),
    },
    {
        id: 'V4',
        description: 'Command-output non-empty input never returns unsupported_input',
        passed: testCasePassedInTap(runtimeSummarizeResult.output, 'command-output never surfaces unsupported_input for non-empty input'),
    },
    {
        id: 'V5a',
        description: 'repo-search CLI delegates to status server endpoint',
        passed: testCasePassedInTap(repoCliResult.output, 'repo-search delegates execution to status server'),
    },
    {
        id: 'V5b',
        description: 'repo-search planner sends append-only cached slot chat payload',
        passed: testCasePassedInTap(repoLoopResult.output, 'runTaskLoop sends append-only chat requests with explicit cache_prompt and a pinned slot'),
    },
    {
        id: 'V6',
        description: 'dashboard chat completion uses hidden tool context handling',
        passed: testCasePassedInTap(dashboardResult.output, 'chat completion receives hidden tool context while keeping it out of visible chat history'),
    },
];
console.log('\n=== Prompt Dispatch Case Matrix ===');
for (const c of cases) {
    const status = c.passed ? 'PASS' : 'FAIL';
    console.log(`${c.id.padEnd(4)} ${status.padEnd(5)} ${c.description}`);
}
const failed = cases.filter((c) => !c.passed);
if (failed.length > 0) {
    console.error(`\nFailed case(s): ${failed.map((f) => f.id).join(', ')}`);
    process.exit(1);
}
console.log('\nAll prompt dispatch/chunking validation cases passed.');
process.exit(0);
