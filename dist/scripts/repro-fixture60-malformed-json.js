#!/usr/bin/env node
"use strict";
// @ts-nocheck — Ad-hoc repro harness; fixture-driven API calls bypass strict type checks.
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseArgs = parseArgs;
exports.resolveWorkItems = resolveWorkItems;
exports.runFixture60MalformedJsonRepro = runFixture60MalformedJsonRepro;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
// Runtime-resolved imports: works from both scripts/ (tsx) and dist/scripts/ (compiled).
const _distRoot = node_path_1.default.resolve(__dirname, '..', 'dist');
const _distExists = node_fs_1.default.existsSync(node_path_1.default.join(_distRoot, 'config', 'index.js'));
const _base = _distExists ? _distRoot : node_path_1.default.resolve(__dirname, '..');
const { loadConfig, getChunkThresholdCharacters, getConfiguredLlamaNumCtx, getConfiguredLlamaSetting, getConfiguredModel, getConfiguredPromptPrefix, getEffectiveInputCharactersPerContextToken, } = require(node_path_1.default.join(_base, 'config', 'index.js'));
const { acquireExecutionLock, releaseExecutionLock } = require(node_path_1.default.join(_base, 'execution-lock.js'));
const { buildPrompt, getSummaryDecision, planTokenAwareLlamaCppChunks, } = require(node_path_1.default.join(_base, 'summary.js'));
const { countLlamaCppTokens, generateLlamaCppResponse } = require(node_path_1.default.join(_base, 'providers', 'llama-cpp.js'));
const LLAMA_CPP_NON_THINKING_PROMPT_TOKEN_RESERVE = 10_000;
const LLAMA_CPP_THINKING_PROMPT_TOKEN_RESERVE = 15_000;
function parseArgs(argv) {
    const parsed = {
        fixtureIndex: 60,
        fixtureStartIndex: null,
        fixtureEndIndex: null,
        outputRoot: '',
        requestTimeoutSeconds: 1800,
        traceSummary: true,
    };
    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];
        switch (token) {
            case '--fixture-index':
                parsed.fixtureIndex = Number(argv[++index]);
                break;
            case '--fixture-start-index':
                parsed.fixtureStartIndex = Number(argv[++index]);
                break;
            case '--fixture-end-index':
                parsed.fixtureEndIndex = Number(argv[++index]);
                break;
            case '--output-root':
                parsed.outputRoot = node_path_1.default.resolve(argv[++index]);
                break;
            case '--request-timeout-seconds':
                parsed.requestTimeoutSeconds = Number(argv[++index]);
                break;
            case '--trace-summary':
                parsed.traceSummary = argv[++index] !== '0';
                break;
            default:
                throw new Error(`Unknown argument: ${token}`);
        }
    }
    if (!Number.isInteger(parsed.fixtureIndex) || parsed.fixtureIndex <= 0) {
        throw new Error('fixture-index must be a positive integer.');
    }
    if (parsed.fixtureStartIndex !== null
        && (!Number.isInteger(parsed.fixtureStartIndex) || parsed.fixtureStartIndex <= 0)) {
        throw new Error('fixture-start-index must be a positive integer.');
    }
    if (parsed.fixtureEndIndex !== null
        && (!Number.isInteger(parsed.fixtureEndIndex) || parsed.fixtureEndIndex <= 0)) {
        throw new Error('fixture-end-index must be a positive integer.');
    }
    if (!Number.isFinite(parsed.requestTimeoutSeconds) || parsed.requestTimeoutSeconds <= 0) {
        throw new Error('request-timeout-seconds must be a positive number.');
    }
    return parsed;
}
function getTimestamp() {
    const current = new Date();
    const yyyy = current.getFullYear();
    const MM = String(current.getMonth() + 1).padStart(2, '0');
    const dd = String(current.getDate()).padStart(2, '0');
    const hh = String(current.getHours()).padStart(2, '0');
    const mm = String(current.getMinutes()).padStart(2, '0');
    const ss = String(current.getSeconds()).padStart(2, '0');
    return `${yyyy}${MM}${dd}_${hh}${mm}${ss}`;
}
function createLogger(logPath, stdoutTarget = process.stdout) {
    node_fs_1.default.mkdirSync(node_path_1.default.dirname(logPath), { recursive: true });
    node_fs_1.default.writeFileSync(logPath, '', 'utf8');
    return {
        log(message) {
            const line = `[fixture60-repro ${new Date().toISOString()}] ${message}`;
            stdoutTarget.write(`${line}\n`);
            node_fs_1.default.appendFileSync(logPath, `${line}\n`, 'utf8');
        },
    };
}
function resolveWorkItems(fixtureRoot, fixtureStartIndex, fixtureEndIndex) {
    const manifestPath = node_path_1.default.join(fixtureRoot, 'fixtures.json');
    const manifest = JSON.parse(node_fs_1.default.readFileSync(manifestPath, 'utf8'));
    const workItems = [];
    for (let fixtureIndex = fixtureStartIndex; fixtureIndex <= fixtureEndIndex; fixtureIndex += 1) {
        const fixture = manifest[fixtureIndex - 1];
        if (!fixture) {
            throw new Error(`Fixture ${fixtureIndex} not found in ${manifestPath}.`);
        }
        const sourcePath = node_path_1.default.join(fixtureRoot, fixture.File);
        workItems.push({
            fixtureIndex,
            fixture,
            sourcePath,
            inputText: node_fs_1.default.readFileSync(sourcePath, 'utf8'),
        });
    }
    return workItems;
}
function writeJson(filePath, value) {
    node_fs_1.default.mkdirSync(node_path_1.default.dirname(filePath), { recursive: true });
    node_fs_1.default.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
function splitTextIntoChunks(text, chunkSize) {
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
function getLlamaCppPromptTokenReserve(config) {
    const reasoning = getConfiguredLlamaSetting(config, 'Reasoning');
    return reasoning === 'off'
        ? LLAMA_CPP_NON_THINKING_PROMPT_TOKEN_RESERVE
        : LLAMA_CPP_THINKING_PROMPT_TOKEN_RESERVE;
}
function getLlamaCppChunkThresholdCharacters(config) {
    const reserveChars = Math.ceil(getLlamaCppPromptTokenReserve(config) * getEffectiveInputCharactersPerContextToken(config));
    return Math.max(getChunkThresholdCharacters(config) - reserveChars, 1);
}
function stripCodeFence(text) {
    const trimmed = String(text || '').trim();
    const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/u.exec(trimmed);
    return match ? match[1].trim() : trimmed;
}
function decodeStructuredOutputText(text) {
    return text
        .replace(/\\\\/gu, '\\')
        .replace(/\\"/gu, '"')
        .replace(/\\r/gu, '\r')
        .replace(/\\n/gu, '\n')
        .replace(/\\t/gu, '\t');
}
function tryRecoverStructuredModelDecision(text) {
    const normalized = stripCodeFence(text);
    const classificationMatch = /"classification"\s*:\s*"(summary|command_failure|unsupported_input)"/iu.exec(normalized);
    const outputMatch = /"output"\s*:\s*"([\s\S]*?)"(?:\s*[}])?\s*$/u.exec(normalized);
    if (!classificationMatch || !outputMatch) {
        return null;
    }
    const rawReviewMatch = /"raw_review_required"\s*:\s*(true|false)|"rawReviewRequired"\s*:\s*(true|false)/iu.exec(normalized);
    return {
        classification: classificationMatch[1].toLowerCase(),
        rawReviewRequired: rawReviewMatch ? /true/iu.test(rawReviewMatch[0]) : false,
        output: decodeStructuredOutputText(outputMatch[1]).trim(),
    };
}
function parseStructuredModelDecision(text) {
    let parsed;
    try {
        parsed = JSON.parse(stripCodeFence(text));
    }
    catch (error) {
        const recovered = tryRecoverStructuredModelDecision(text);
        if (recovered) {
            return recovered;
        }
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Provider returned an invalid SiftKit decision payload: ${message}`);
    }
    const classification = typeof parsed.classification === 'string'
        ? parsed.classification.trim().toLowerCase()
        : '';
    if (!['summary', 'command_failure', 'unsupported_input'].includes(classification)) {
        throw new Error('Provider returned an invalid SiftKit decision classification.');
    }
    if (typeof parsed.output !== 'string' || !parsed.output.trim()) {
        throw new Error('Provider returned an empty SiftKit decision output.');
    }
    return {
        classification,
        rawReviewRequired: Boolean(parsed.raw_review_required ?? parsed.rawReviewRequired ?? false),
        output: parsed.output.trim(),
    };
}
function getFixtureBounds(args) {
    const fixtureStartIndex = args.fixtureStartIndex ?? args.fixtureEndIndex ?? args.fixtureIndex;
    const fixtureEndIndex = args.fixtureEndIndex ?? args.fixtureStartIndex ?? args.fixtureIndex;
    if (fixtureStartIndex > fixtureEndIndex) {
        throw new Error('fixture-start-index must be less than or equal to fixture-end-index.');
    }
    return { fixtureStartIndex, fixtureEndIndex };
}
function buildFixtureManifest(workItem, backend, model, requestTimeoutSeconds) {
    return {
        ok: false,
        fixtureIndex: workItem.fixtureIndex,
        sourcePath: workItem.sourcePath,
        fixtureName: workItem.fixture.Name,
        backend,
        model,
        requestTimeoutSeconds,
        rawReviewRequired: false,
        chunkThreshold: 0,
        effectivePromptLimit: 0,
        chunkCount: 0,
        malformedChunk: null,
        chunks: [],
    };
}
function mirrorFixtureSummary(manifest, fixtureManifest) {
    manifest.fixtureIndex = fixtureManifest.fixtureIndex;
    manifest.sourcePath = fixtureManifest.sourcePath;
    manifest.fixtureName = fixtureManifest.fixtureName;
    manifest.rawReviewRequired = fixtureManifest.rawReviewRequired;
    manifest.chunkThreshold = fixtureManifest.chunkThreshold;
    manifest.effectivePromptLimit = fixtureManifest.effectivePromptLimit;
    manifest.chunkCount = fixtureManifest.chunkCount;
    manifest.malformedChunk = fixtureManifest.malformedChunk;
    manifest.chunks = fixtureManifest.chunks;
}
async function runFixture60MalformedJsonRepro(argv, options = {}) {
    const args = parseArgs(argv);
    const { fixtureStartIndex, fixtureEndIndex } = getFixtureBounds(args);
    const repoRoot = node_path_1.default.resolve(__dirname, '..');
    const fixtureRoot = options.fixtureRoot || node_path_1.default.join(repoRoot, 'eval', 'fixtures', 'ai_core_60_tests');
    const outputRoot = args.outputRoot || node_path_1.default.join(repoRoot, 'tmp-find', `fixture60_malformed_json_${getTimestamp()}`);
    const logPath = node_path_1.default.join(outputRoot, 'debug.log');
    const manifestPath = node_path_1.default.join(outputRoot, 'manifest.json');
    const stdoutTarget = options.stdout || process.stdout;
    const stderrTarget = options.stderr || process.stderr;
    const logger = createLogger(logPath, stdoutTarget);
    const previousTraceSummary = process.env.SIFTKIT_TRACE_SUMMARY;
    const manifest = {
        ok: false,
        fixtureIndex: fixtureStartIndex,
        fixtureStartIndex,
        fixtureEndIndex,
        fixtureCount: 0,
        fixtureRoot,
        sourcePath: '',
        fixtureName: '',
        backend: '',
        model: '',
        requestTimeoutSeconds: args.requestTimeoutSeconds,
        rawReviewRequired: false,
        chunkThreshold: 0,
        effectivePromptLimit: 0,
        chunkCount: 0,
        malformedChunk: null,
        chunks: [],
        malformedFixture: null,
        fixtures: [],
    };
    if (args.traceSummary) {
        process.env.SIFTKIT_TRACE_SUMMARY = '1';
    }
    let lock = null;
    try {
        const workItems = resolveWorkItems(fixtureRoot, fixtureStartIndex, fixtureEndIndex);
        const config = await loadConfig({ ensure: true });
        const backend = config.Backend;
        const model = getConfiguredModel(config);
        if (backend !== 'llama.cpp') {
            throw new Error(`This repro script requires backend=llama.cpp. Current backend: ${backend}.`);
        }
        const promptPrefix = getConfiguredPromptPrefix(config);
        manifest.backend = backend;
        manifest.model = model;
        manifest.fixtureCount = workItems.length;
        node_fs_1.default.mkdirSync(outputRoot, { recursive: true });
        writeJson(manifestPath, manifest);
        logger.log(`Output root: ${outputRoot}`);
        logger.log(`Fixture range: ${fixtureStartIndex}-${fixtureEndIndex}`);
        logger.log(`Fixture count: ${workItems.length}`);
        lock = await acquireExecutionLock();
        for (const workItem of workItems) {
            const fixtureManifest = buildFixtureManifest(workItem, backend, model, args.requestTimeoutSeconds);
            const fixtureOutputRoot = node_path_1.default.join(outputRoot, 'fixtures', `fixture-${String(workItem.fixtureIndex).padStart(2, '0')}`);
            const fixtureManifestPath = node_path_1.default.join(fixtureOutputRoot, 'manifest.json');
            const riskLevel = workItem.fixture.PolicyProfile === 'risky-operation' ? 'risky' : 'informational';
            const decision = getSummaryDecision(workItem.inputText, workItem.fixture.Question, riskLevel, config);
            const chunkThreshold = getLlamaCppChunkThresholdCharacters(config);
            const effectivePromptLimit = getConfiguredLlamaNumCtx(config) - getLlamaCppPromptTokenReserve(config);
            const chunks = workItem.inputText.length > chunkThreshold
                ? (await planTokenAwareLlamaCppChunks({
                    question: workItem.fixture.Question,
                    inputText: workItem.inputText,
                    format: workItem.fixture.Format,
                    policyProfile: workItem.fixture.PolicyProfile,
                    rawReviewRequired: decision.RawReviewRequired,
                    promptPrefix,
                    sourceKind: 'standalone',
                    config,
                    chunkThreshold,
                    phase: 'leaf',
                    chunkContext: {
                        isGeneratedChunk: true,
                        mayBeTruncated: true,
                        retryMode: 'default',
                        chunkPath: null,
                    },
                }) ?? splitTextIntoChunks(workItem.inputText, chunkThreshold))
                : [workItem.inputText];
            fixtureManifest.rawReviewRequired = decision.RawReviewRequired;
            fixtureManifest.chunkThreshold = chunkThreshold;
            fixtureManifest.effectivePromptLimit = effectivePromptLimit;
            fixtureManifest.chunkCount = chunks.length;
            manifest.fixtures.push(fixtureManifest);
            mirrorFixtureSummary(manifest, fixtureManifest);
            writeJson(fixtureManifestPath, fixtureManifest);
            writeJson(manifestPath, manifest);
            logger.log(`Fixture ${workItem.fixtureIndex}/${fixtureEndIndex}: ${workItem.fixture.Name}`);
            logger.log(`Source path: ${workItem.sourcePath}`);
            logger.log(`Input chars: ${workItem.inputText.length}`);
            logger.log(`Chunk threshold: ${chunkThreshold}`);
            logger.log(`Chunk count: ${chunks.length}`);
            for (let index = 0; index < chunks.length; index += 1) {
                const chunkIndex = index + 1;
                const chunkPath = `${chunkIndex}/${chunks.length}`;
                const chunkRoot = node_path_1.default.join(fixtureOutputRoot, 'chunks', `chunk-${String(chunkIndex).padStart(2, '0')}`);
                const promptPath = node_path_1.default.join(chunkRoot, 'prompt.txt');
                const responsePath = node_path_1.default.join(chunkRoot, 'response.txt');
                const chunkManifestPath = node_path_1.default.join(chunkRoot, 'chunk.json');
                const prompt = buildPrompt({
                    question: workItem.fixture.Question,
                    inputText: chunks[index],
                    format: workItem.fixture.Format,
                    policyProfile: workItem.fixture.PolicyProfile,
                    rawReviewRequired: decision.RawReviewRequired,
                    promptPrefix,
                    sourceKind: 'standalone',
                    phase: 'leaf',
                    chunkContext: {
                        isGeneratedChunk: true,
                        mayBeTruncated: true,
                        retryMode: 'default',
                        chunkPath,
                    },
                });
                const promptTokenCount = await countLlamaCppTokens(config, prompt);
                const response = await generateLlamaCppResponse({
                    config,
                    model,
                    prompt,
                    timeoutSeconds: args.requestTimeoutSeconds,
                });
                node_fs_1.default.mkdirSync(chunkRoot, { recursive: true });
                node_fs_1.default.writeFileSync(promptPath, prompt, 'utf8');
                node_fs_1.default.writeFileSync(responsePath, response.text, 'utf8');
                const chunkRecord = {
                    index: chunkIndex,
                    chunkPath,
                    inputCharacters: chunks[index].length,
                    promptCharacters: prompt.length,
                    promptTokens: promptTokenCount,
                    outputCharacters: response.text.length,
                    outputTokens: response.usage?.completionTokens ?? null,
                    promptPath,
                    responsePath,
                    parsed: false,
                    classification: null,
                    rawReviewRequired: null,
                    outputPreview: null,
                    error: null,
                };
                try {
                    const parsedDecision = parseStructuredModelDecision(response.text);
                    chunkRecord.parsed = true;
                    chunkRecord.classification = parsedDecision.classification;
                    chunkRecord.rawReviewRequired = parsedDecision.rawReviewRequired;
                    chunkRecord.outputPreview = parsedDecision.output.slice(0, 500);
                    logger.log(`Fixture ${workItem.fixtureIndex} chunk ${chunkPath} parsed prompt_tokens=${promptTokenCount ?? 'null'} `
                        + `output_tokens=${chunkRecord.outputTokens ?? 'null'}`);
                }
                catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    chunkRecord.error = message;
                    fixtureManifest.malformedChunk = {
                        index: chunkIndex,
                        chunkPath,
                        promptPath,
                        responsePath,
                        error: message,
                    };
                    fixtureManifest.chunks.push(chunkRecord);
                    manifest.malformedFixture = {
                        fixtureIndex: workItem.fixtureIndex,
                        fixtureName: workItem.fixture.Name,
                        sourcePath: workItem.sourcePath,
                        chunkPath,
                        error: message,
                    };
                    mirrorFixtureSummary(manifest, fixtureManifest);
                    writeJson(chunkManifestPath, chunkRecord);
                    writeJson(fixtureManifestPath, fixtureManifest);
                    writeJson(manifestPath, manifest);
                    logger.log(`Fixture ${workItem.fixtureIndex} chunk ${chunkPath} malformed: ${message}`);
                    stderrTarget.write(`${message}\n`);
                    return {
                        exitCode: 1,
                        manifestPath,
                        manifest,
                    };
                }
                fixtureManifest.chunks.push(chunkRecord);
                mirrorFixtureSummary(manifest, fixtureManifest);
                writeJson(chunkManifestPath, chunkRecord);
                writeJson(fixtureManifestPath, fixtureManifest);
                writeJson(manifestPath, manifest);
            }
            fixtureManifest.ok = true;
            mirrorFixtureSummary(manifest, fixtureManifest);
            writeJson(fixtureManifestPath, fixtureManifest);
            writeJson(manifestPath, manifest);
        }
        manifest.ok = true;
        writeJson(manifestPath, manifest);
        logger.log('Completed without malformed chunk payloads.');
        return {
            exitCode: 0,
            manifestPath,
            manifest,
        };
    }
    catch (error) {
        const message = error instanceof Error ? (error.stack || error.message) : String(error);
        manifest.error = message;
        writeJson(manifestPath, manifest);
        stderrTarget.write(`${message}\n`);
        return {
            exitCode: 1,
            manifestPath,
            manifest,
        };
    }
    finally {
        if (lock) {
            try {
                await releaseExecutionLock(lock);
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                manifest.lockReleaseError = message;
                if (node_fs_1.default.existsSync(node_path_1.default.dirname(manifestPath))) {
                    writeJson(manifestPath, manifest);
                }
                logger.log(`Lock release warning: ${message}`);
                stderrTarget.write(`Warning: ${message}\n`);
            }
        }
        if (previousTraceSummary === undefined) {
            delete process.env.SIFTKIT_TRACE_SUMMARY;
        }
        else {
            process.env.SIFTKIT_TRACE_SUMMARY = previousTraceSummary;
        }
    }
}
async function main() {
    const result = await runFixture60MalformedJsonRepro(process.argv.slice(2));
    process.exit(result.exitCode);
}
// ESM entry point check
const isMainModule = process.argv[1] && (process.argv[1].endsWith('repro-fixture60-malformed-json.ts') ||
    process.argv[1].endsWith('repro-fixture60-malformed-json.js'));
if (isMainModule) {
    main().catch((error) => {
        const message = error instanceof Error ? (error.stack || error.message) : String(error);
        process.stderr.write(`${message}\n`);
        process.exit(1);
    });
}
