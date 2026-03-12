"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const fs = __importStar(require("node:fs"));
const http = __importStar(require("node:http"));
const os = __importStar(require("node:os"));
const path = __importStar(require("node:path"));
const MAX_NUM_PREDICT = 10_000;
function normalizeCliValue(value) {
    let normalized = value.trim();
    if (normalized.includes('^')) {
        normalized = normalized.replace(/\^/g, '');
    }
    if ((normalized.startsWith('"') && normalized.endsWith('"'))
        || (normalized.startsWith("'") && normalized.endsWith("'"))) {
        normalized = normalized.slice(1, -1);
    }
    return normalized;
}
function getArg(args, key) {
    const value = args.get(key);
    if (value === undefined) {
        return undefined;
    }
    return normalizeCliValue(value);
}
function resolveCliPath(inputPath) {
    if (path.isAbsolute(inputPath)) {
        return path.normalize(inputPath);
    }
    return path.resolve(process.cwd(), inputPath);
}
function toFiniteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
function formatTokensPerSecond(count, durationNs) {
    const tokenCount = toFiniteNumber(count);
    const duration = toFiniteNumber(durationNs);
    if (tokenCount === null || duration === null || duration <= 0) {
        return null;
    }
    return (tokenCount / (duration / 1_000_000_000)).toFixed(2);
}
function parseArgs(argv) {
    const parsed = new Map();
    for (let i = 2; i < argv.length; i += 1) {
        const arg = argv[i];
        if (!arg.startsWith('--')) {
            continue;
        }
        const key = arg.slice(2);
        const next = argv[i + 1];
        if (!next || next.startsWith('--')) {
            parsed.set(key, 'true');
            continue;
        }
        parsed.set(key, next);
        i += 1;
    }
    return parsed;
}
function log(label, detail = '') {
    const suffix = detail ? `: ${detail}` : '';
    process.stdout.write(`${label}${suffix}\n`);
}
function fail(message) {
    process.stderr.write(`${message}\n`);
    process.exit(1);
}
function ensureDir(dirPath) {
    fs.mkdirSync(dirPath, { recursive: true });
}
function writeJsonLine(filePath, data) {
    fs.appendFileSync(filePath, `${JSON.stringify(data)}\n`, 'utf8');
}
function timed(fn) {
    const started = Date.now();
    const value = fn();
    return { value, elapsedMs: Date.now() - started };
}
function buildPrompt(options) {
    const promptProfiles = {
        general: [
            'Summarize only the information supported by the input. Prefer short bullets or short prose.',
            'Do not invent causes, fixes, or certainty that the input does not support.',
        ].join('\n'),
        'pass-fail': [
            'Focus on pass/fail status. If failures exist, list only failing tests or suites and the first concrete error for each.',
            'Do not include passing tests.',
        ].join('\n'),
        'unique-errors': [
            'Extract unique real errors. Group repeated lines. Ignore informational noise and warnings unless they directly indicate failure.',
        ].join('\n'),
        'buried-critical': [
            'Identify the single decisive failure or highest-priority problem if one exists. Ignore repeated harmless lines.',
        ].join('\n'),
        'json-extraction': [
            'Return only valid JSON. No code fences, commentary, or markdown. Preserve exact identifiers when present.',
        ].join('\n'),
        'diff-summary': [
            'Summarize functional changes, not formatting churn. Distinguish behavior changes from refactors when possible.',
        ].join('\n'),
        'risky-operation': [
            'Be conservative. Do not judge the operation safe. Extract facts, highlight destructive or risky actions, and say raw review is still required.',
        ].join('\n'),
    };
    const profilePrompt = promptProfiles[options.policyProfile] || promptProfiles.general;
    const formatPrompt = options.format === 'json'
        ? 'Return only valid JSON. Do not use markdown fences.'
        : 'Return concise plain text.';
    const rawReviewPrompt = options.rawReviewRequired
        ? 'Raw-log review is still required before any risky decision. State that explicitly.'
        : 'Keep the answer focused and factual.';
    return [
        'You are SiftKit, a conservative shell-output compressor for Codex workflows.',
        '',
        'Rules:',
        '- Preserve the most decisive facts.',
        '- Prefer extraction over explanation.',
        '- Never claim certainty beyond the input.',
        '- If evidence is incomplete or ambiguous, say so.',
        '- Do not suggest destructive actions.',
        '',
        'Profile:',
        profilePrompt,
        '',
        'Output:',
        formatPrompt,
        '',
        'Risk handling:',
        rawReviewPrompt,
        '',
        'Question:',
        options.question,
        '',
        'Input:',
        options.inputText,
    ].join('\n');
}
function splitIntoChunks(text, chunkSize) {
    if (chunkSize <= 0) {
        throw new Error('chunkSize must be greater than zero.');
    }
    if (text.length <= chunkSize) {
        return [text];
    }
    const chunks = [];
    for (let offset = 0; offset < text.length; offset += chunkSize) {
        chunks.push(text.substring(offset, Math.min(offset + chunkSize, text.length)));
    }
    return chunks;
}
function postGenerate(options) {
    return new Promise((resolve, reject) => {
        const requestStartedAt = Date.now();
        let firstByteAt = null;
        const req = http.request({
            hostname: options.host,
            port: options.port,
            path: '/api/generate',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(options.body, 'utf8'),
            },
            timeout: options.timeoutSeconds * 1000,
        }, (res) => {
            let responseText = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => {
                if (firstByteAt === null) {
                    firstByteAt = Date.now();
                }
                responseText += chunk;
            });
            res.on('end', () => {
                resolve({
                    statusCode: res.statusCode || 0,
                    responseText,
                    requestMs: Date.now() - requestStartedAt,
                    firstByteMs: firstByteAt === null ? null : firstByteAt - requestStartedAt,
                });
            });
        });
        req.on('timeout', () => {
            req.destroy(new Error(`Request timed out after ${options.timeoutSeconds} seconds.`));
        });
        req.on('error', reject);
        req.write(options.body);
        req.end();
    });
}
async function main() {
    const args = parseArgs(process.argv);
    const sourcePath = resolveCliPath(getArg(args, 'source-path')
        || 'C:\\Users\\denys\\Documents\\GitHub\\ai_idle\\core_project - Copy\\rg_hardcoded_keys_output.txt');
    const model = getArg(args, 'model') || 'qwen3.5:9b-q4_K_M';
    const host = getArg(args, 'host') || '127.0.0.1';
    const port = Number(getArg(args, 'port') || '11434');
    const numCtx = Number(getArg(args, 'num-ctx') || '140000');
    const chunkThresholdRatio = Number(getArg(args, 'chunk-threshold-ratio') || '0.90');
    const requestedNumPredict = Number(getArg(args, 'num-predict') || String(MAX_NUM_PREDICT));
    const numPredict = Math.min(Math.max(Math.floor(requestedNumPredict), 1), MAX_NUM_PREDICT);
    const timeoutSeconds = Number(getArg(args, 'timeout-seconds') || '180');
    const delaySeconds = Number(getArg(args, 'delay-seconds') || '0');
    const question = getArg(args, 'question')
        || 'find the main files and hotspots where hardcoded tech unlock or status effect keys are used';
    const outputRoot = resolveCliPath(getArg(args, 'output-root')
        || path.join(os.tmpdir(), 'siftkit-full-ts-test'));
    ensureDir(outputRoot);
    if (!fs.existsSync(sourcePath)) {
        fail(`Source file not found: ${sourcePath}`);
    }
    if (requestedNumPredict !== numPredict) {
        log('Num predict adjusted', `${requestedNumPredict} -> ${numPredict}`);
    }
    log('Reading source', sourcePath);
    const readResult = timed(() => fs.readFileSync(sourcePath, 'utf8'));
    const sourceText = readResult.value;
    log('Read source ms', String(readResult.elapsedMs));
    log('Source chars', String(sourceText.length));
    const maxInputCharacters = Math.max(Math.floor(numCtx * 2.5), 1);
    const chunkThreshold = Math.max(Math.floor(maxInputCharacters * chunkThresholdRatio), 1);
    const chunks = splitIntoChunks(sourceText, chunkThreshold);
    const metadata = {
        sourcePath,
        sourceChars: sourceText.length,
        model,
        host,
        port,
        numCtx,
        numPredict,
        timeoutSeconds,
        delaySeconds,
        chunkThresholdRatio,
        maxInputCharacters,
        chunkThreshold,
        initialChunkCount: chunks.length,
        outputRoot,
    };
    fs.writeFileSync(path.join(outputRoot, 'metadata.json'), JSON.stringify(metadata, null, 2), 'utf8');
    const resultsPath = path.join(outputRoot, 'results.jsonl');
    fs.writeFileSync(resultsPath, '', 'utf8');
    async function summarizeCore(params) {
        if (params.inputText.length > chunkThreshold) {
            const nestedChunks = splitIntoChunks(params.inputText, chunkThreshold);
            const chunkSummaries = [];
            for (let index = 0; index < nestedChunks.length; index += 1) {
                const summary = await summarizeCore({
                    inputText: nestedChunks[index],
                    phase: params.phase,
                    depth: params.depth + 1,
                    rootInputCharacters: params.rootInputCharacters,
                    chunkIndex: index + 1,
                    chunkTotal: nestedChunks.length,
                });
                chunkSummaries.push(summary);
                if (delaySeconds > 0 && index < nestedChunks.length - 1) {
                    await new Promise((resolve) => setTimeout(resolve, delaySeconds * 1000));
                }
            }
            const mergeSections = [];
            for (let index = 0; index < chunkSummaries.length; index += 1) {
                mergeSections.push(`Summary of chunk ${index + 1}:`);
                mergeSections.push(chunkSummaries[index]);
                if (index < chunkSummaries.length - 1) {
                    mergeSections.push('');
                }
            }
            return summarizeCore({
                inputText: mergeSections.join('\n'),
                phase: 'merge',
                depth: params.depth + 1,
                rootInputCharacters: params.rootInputCharacters,
                chunkIndex: null,
                chunkTotal: null,
                questionOverride: `Merge these partial summaries into one final answer for the original question: ${question}`,
            });
        }
        const effectiveQuestion = params.questionOverride || question;
        const promptResult = timed(() => buildPrompt({
            question: effectiveQuestion,
            inputText: params.inputText,
            format: 'text',
            policyProfile: 'general',
            rawReviewRequired: false,
        }));
        const prompt = promptResult.value;
        const bodyResult = timed(() => JSON.stringify({
            model,
            prompt,
            stream: false,
            think: false,
            options: {
                temperature: 0.2,
                top_p: 0.95,
                top_k: 20,
                min_p: 0.0,
                presence_penalty: 0.0,
                repeat_penalty: 1.0,
                num_ctx: numCtx,
                num_predict: numPredict,
            },
        }));
        const requestName = `${params.phase}-d${String(params.depth).padStart(2, '0')}-${params.chunkIndex ?? 0}`;
        fs.writeFileSync(path.join(outputRoot, `${requestName}-prompt.txt`), prompt, 'utf8');
        log('Request', `${requestName} input=${params.inputText.length} prompt=${prompt.length}`);
        const response = await postGenerate({
            host,
            port,
            timeoutSeconds,
            body: bodyResult.value,
        });
        let parsed;
        try {
            parsed = JSON.parse(response.responseText);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const record = {
                phase: params.phase,
                depth: params.depth,
                chunkIndex: params.chunkIndex,
                chunkTotal: params.chunkTotal,
                inputCharacters: params.inputText.length,
                promptCharacters: prompt.length,
                promptBuildMs: promptResult.elapsedMs,
                jsonBuildMs: bodyResult.elapsedMs,
                requestMs: response.requestMs,
                firstByteMs: response.firstByteMs,
                httpStatusCode: response.statusCode,
                status: 'error',
                errorMessage: `Invalid JSON response: ${message}`,
            };
            writeJsonLine(resultsPath, record);
            throw new Error(record.errorMessage);
        }
        const summary = typeof parsed.response === 'string' ? parsed.response.trim() : '';
        const record = {
            phase: params.phase,
            depth: params.depth,
            chunkIndex: params.chunkIndex,
            chunkTotal: params.chunkTotal,
            inputCharacters: params.inputText.length,
            promptCharacters: prompt.length,
            promptBuildMs: promptResult.elapsedMs,
            jsonBuildMs: bodyResult.elapsedMs,
            requestMs: response.requestMs,
            firstByteMs: response.firstByteMs,
            httpStatusCode: response.statusCode,
            status: response.statusCode >= 400 ? 'error' : 'success',
            summaryCharacters: summary.length,
            doneReason: parsed.done_reason ?? null,
            promptEvalCount: parsed.prompt_eval_count ?? null,
            evalCount: parsed.eval_count ?? null,
            totalDuration: parsed.total_duration ?? null,
            loadDuration: parsed.load_duration ?? null,
            promptEvalDuration: parsed.prompt_eval_duration ?? null,
            evalDuration: parsed.eval_duration ?? null,
        };
        writeJsonLine(resultsPath, record);
        if (response.statusCode >= 400) {
            throw new Error(`HTTP ${response.statusCode}: ${response.responseText}`);
        }
        fs.writeFileSync(path.join(outputRoot, `${requestName}-response.json`), JSON.stringify(parsed, null, 2), 'utf8');
        log('Completed', `${requestName} in ${response.requestMs} ms`);
        const promptTokensPerSecond = formatTokensPerSecond(parsed.prompt_eval_count, parsed.prompt_eval_duration);
        if (promptTokensPerSecond !== null) {
            log('Prompt throughput', `${requestName} ${parsed.prompt_eval_count} tokens in ${parsed.prompt_eval_duration} ns (${promptTokensPerSecond} tok/s)`);
        }
        const evalTokensPerSecond = formatTokensPerSecond(parsed.eval_count, parsed.eval_duration);
        if (evalTokensPerSecond !== null) {
            log('Eval throughput', `${requestName} ${parsed.eval_count} tokens in ${parsed.eval_duration} ns (${evalTokensPerSecond} tok/s)`);
        }
        return summary;
    }
    try {
        const finalSummary = await summarizeCore({
            inputText: sourceText,
            phase: 'leaf',
            depth: 0,
            rootInputCharacters: sourceText.length,
            chunkIndex: null,
            chunkTotal: null,
        });
        fs.writeFileSync(path.join(outputRoot, 'final-summary.txt'), finalSummary, 'utf8');
        log('Final summary chars', String(finalSummary.length));
        log('Output root', outputRoot);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        fail(`Run failed: ${message}`);
    }
}
void main();
