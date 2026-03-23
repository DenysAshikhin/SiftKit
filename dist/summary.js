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
exports.UNSUPPORTED_INPUT_MESSAGE = void 0;
exports.getDeterministicExcerpt = getDeterministicExcerpt;
exports.getSummaryDecision = getSummaryDecision;
exports.planTokenAwareLlamaCppChunks = planTokenAwareLlamaCppChunks;
exports.buildPrompt = buildPrompt;
exports.summarizeRequest = summarizeRequest;
exports.readSummaryInput = readSummaryInput;
const fs = __importStar(require("node:fs"));
const config_js_1 = require("./config.js");
const execution_lock_js_1 = require("./execution-lock.js");
const llama_cpp_js_1 = require("./providers/llama-cpp.js");
exports.UNSUPPORTED_INPUT_MESSAGE = 'The command/input is either unsupported or failed. Please verify the command that it is supported in the current environment and returns proper input. If it does, raise an explicit error to the user and stop futher processing.';
const PROMPT_PROFILES = {
    general: [
        'Summarize only the information supported by the input.',
        'Lead with the main conclusion before supporting evidence.',
        'Do not invent causes, fixes, or certainty that the input does not support.',
    ].join('\n'),
    'pass-fail': [
        'Focus on pass/fail status.',
        'If failures exist, lead with the failing status and the decisive failure reason.',
        'Do not spend space on passing tests unless they matter to a caveat.',
    ].join('\n'),
    'unique-errors': [
        'Extract unique real errors.',
        'Group repeated lines.',
        'Ignore informational noise and warnings unless they directly indicate failure.',
    ].join('\n'),
    'buried-critical': [
        'Identify the single decisive failure or highest-priority problem if one exists.',
        'Ignore repeated harmless lines.',
    ].join('\n'),
    'json-extraction': [
        'Produce the requested extraction faithfully.',
        'If classification is summary or command_failure, the output payload itself must be valid JSON text.',
    ].join('\n'),
    'diff-summary': [
        'Summarize functional changes, not formatting churn.',
        'Distinguish behavior changes from refactors when possible.',
    ].join('\n'),
    'risky-operation': [
        'Be conservative.',
        'Do not judge the operation safe.',
        'Highlight destructive or risky actions and set raw_review_required to true.',
    ].join('\n'),
};
function normalizeInputText(text) {
    if (text === null || text === undefined) {
        return null;
    }
    return text.replace(/[\r\n]+$/u, '');
}
function measureText(text) {
    const normalized = text.replace(/\r\n/gu, '\n');
    return {
        CharacterCount: text.length,
        LineCount: normalized.length > 0 ? normalized.split('\n').length : 0,
    };
}
function getQuestionAnalysis(question) {
    const normalized = question ? question.toLowerCase() : '';
    const patterns = [
        { pattern: /file matching|exact file|find files|exact match/u, reason: 'exact-file-match' },
        { pattern: /schema|summarize schema/u, reason: 'schema-inspection' },
        { pattern: /summarize conflicts|conflict/u, reason: 'conflict-review' },
        { pattern: /summarize edits|edited|diff|patch/u, reason: 'edit-review' },
        { pattern: /root exception|first relevant application frame|first relevant frame/u, reason: 'stack-triage' },
    ];
    for (const entry of patterns) {
        if (entry.pattern.test(normalized)) {
            return {
                IsExactDiagnosis: true,
                Reason: entry.reason,
            };
        }
    }
    return {
        IsExactDiagnosis: false,
        Reason: null,
    };
}
function getErrorSignalMetrics(text) {
    const lines = text.replace(/\r\n/gu, '\n').split('\n');
    let nonEmptyLineCount = 0;
    let errorLineCount = 0;
    const errorPattern = /\b(error|exception|traceback|fatal|conflict|denied|panic|timed out|timeout|script error|parse error)\b/iu;
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
            continue;
        }
        nonEmptyLineCount += 1;
        if (/\b0 failed\b/iu.test(trimmed) && !/\b([1-9]\d*|all)\s+failed\b/iu.test(trimmed)) {
            continue;
        }
        if (errorPattern.test(trimmed)) {
            errorLineCount += 1;
        }
    }
    return {
        NonEmptyLineCount: nonEmptyLineCount,
        ErrorLineCount: errorLineCount,
        ErrorRatio: nonEmptyLineCount > 0 ? errorLineCount / nonEmptyLineCount : 0,
    };
}
function getDeterministicExcerpt(text, question) {
    if (!text || !text.trim()) {
        return null;
    }
    const lines = text.replace(/\r\n/gu, '\n').split('\n');
    const significant = [];
    const analysis = getQuestionAnalysis(question);
    for (const line of lines) {
        if (!line.trim()) {
            continue;
        }
        if (/\b(fatal|error|exception|traceback|failed|conflict|<<<<<<<|>>>>>>>|schema|stderr)\b/iu.test(line)
            || (analysis.IsExactDiagnosis && /\b(test|assert|frame|file|table|column|constraint)\b/iu.test(line))) {
            significant.push(line.trim());
        }
        if (significant.length >= 12) {
            break;
        }
    }
    if (significant.length === 0) {
        return null;
    }
    return [...new Set(significant)].join('\n');
}
function getSummaryDecision(text, question, riskLevel, config) {
    const metrics = measureText(text);
    const errorMetrics = getErrorSignalMetrics(text);
    const hasMaterialErrorSignals = (errorMetrics.ErrorLineCount > 0
        && (errorMetrics.NonEmptyLineCount <= 20
            || (errorMetrics.ErrorLineCount >= 5 && errorMetrics.ErrorRatio >= 0.25)
            || errorMetrics.ErrorRatio >= 0.25));
    const isShort = (metrics.CharacterCount < Number(config.Thresholds.MinCharactersForSummary)
        && metrics.LineCount < Number(config.Thresholds.MinLinesForSummary));
    const rawReviewRequired = riskLevel !== 'informational' || hasMaterialErrorSignals;
    const reason = isShort
        ? 'model-first-short'
        : (rawReviewRequired ? 'model-first-risk-review' : 'model-first');
    return {
        ShouldSummarize: true,
        Reason: question ? reason : 'model-first',
        RawReviewRequired: rawReviewRequired,
        CharacterCount: metrics.CharacterCount,
        LineCount: metrics.LineCount,
    };
}
function splitTextIntoChunks(text, chunkSize) {
    if (chunkSize <= 0) {
        throw new Error('ChunkSize must be greater than zero.');
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
async function countPromptTokensForChunk(options) {
    const prompt = buildPrompt({
        question: options.question,
        inputText: options.inputText,
        format: options.format,
        policyProfile: options.policyProfile,
        rawReviewRequired: options.rawReviewRequired,
        promptPrefix: options.promptPrefix,
        sourceKind: options.sourceKind,
        commandExitCode: options.commandExitCode,
        phase: options.phase,
    });
    return (0, llama_cpp_js_1.countLlamaCppTokens)(options.config, prompt);
}
async function planTokenAwareLlamaCppChunks(options) {
    const effectivePromptLimit = (0, config_js_1.getConfiguredLlamaNumCtx)(options.config) - LLAMA_CPP_PROMPT_TOKEN_RESERVE;
    if (effectivePromptLimit <= 0) {
        return null;
    }
    const chunks = [];
    let offset = 0;
    while (offset < options.inputText.length) {
        const remainingLength = options.inputText.length - offset;
        const targetSlackTokens = Math.min(LLAMA_CPP_PROMPT_TOKEN_TARGET_TOLERANCE, effectivePromptLimit);
        let candidateLength = Math.min(options.chunkThreshold, remainingLength);
        let acceptedChunk = null;
        let acceptedLength = 0;
        let rejectedLength = null;
        let adjustmentCount = 0;
        while (candidateLength > 0 && adjustmentCount < MAX_TOKEN_AWARE_CHUNK_ADJUSTMENTS) {
            adjustmentCount += 1;
            const candidateText = options.inputText.substring(offset, offset + candidateLength);
            const promptTokenCount = await countPromptTokensForChunk({
                question: options.question,
                inputText: candidateText,
                format: options.format,
                policyProfile: options.policyProfile,
                rawReviewRequired: options.rawReviewRequired,
                promptPrefix: options.promptPrefix,
                sourceKind: options.sourceKind,
                commandExitCode: options.commandExitCode,
                config: options.config,
                phase: options.phase,
            });
            if (promptTokenCount === null) {
                return null;
            }
            if (promptTokenCount <= effectivePromptLimit) {
                acceptedChunk = candidateText;
                acceptedLength = candidateLength;
                const slackTokens = effectivePromptLimit - promptTokenCount;
                if (slackTokens <= targetSlackTokens
                    || candidateLength >= remainingLength
                    || rejectedLength === acceptedLength + 1) {
                    break;
                }
                if (rejectedLength !== null) {
                    candidateLength = Math.max(acceptedLength + 1, Math.floor((acceptedLength + rejectedLength) / 2));
                    continue;
                }
                const grownLength = Math.min(remainingLength, Math.max(acceptedLength + 1, Math.floor(acceptedLength * (effectivePromptLimit / Math.max(promptTokenCount, 1)))));
                if (grownLength <= acceptedLength) {
                    break;
                }
                candidateLength = grownLength;
                continue;
            }
            rejectedLength = candidateLength;
            if (acceptedLength > 0) {
                candidateLength = Math.max(acceptedLength + 1, Math.floor((acceptedLength + rejectedLength) / 2));
                continue;
            }
            const reducedLength = getTokenAwareChunkThreshold({
                inputLength: candidateLength,
                promptTokenCount,
                effectivePromptLimit,
            });
            if (reducedLength === null || reducedLength >= candidateLength) {
                return null;
            }
            candidateLength = reducedLength;
        }
        if (!acceptedChunk) {
            return null;
        }
        chunks.push(acceptedChunk);
        offset += acceptedChunk.length;
    }
    return chunks;
}
function shouldRetryWithSmallerChunks(options) {
    if (options.backend !== 'llama.cpp') {
        return false;
    }
    if (options.chunkThreshold <= 1 || options.inputText.length <= 1) {
        return false;
    }
    const message = options.error instanceof Error ? options.error.message : String(options.error);
    return /llama\.cpp generate failed with HTTP 400\b/iu.test(message);
}
const LLAMA_CPP_PROMPT_TOKEN_RESERVE = 1024;
const LLAMA_CPP_PROMPT_TOKEN_TARGET_TOLERANCE = 2000;
const MAX_TOKEN_AWARE_CHUNK_ADJUSTMENTS = 8;
function getTokenAwareChunkThreshold(options) {
    if (options.inputLength <= 1
        || options.promptTokenCount <= options.effectivePromptLimit
        || options.effectivePromptLimit <= 0) {
        return null;
    }
    const scaledThreshold = Math.floor(options.inputLength * (options.effectivePromptLimit / options.promptTokenCount) * 0.95);
    const reducedThreshold = Math.max(1, Math.min(options.inputLength - 1, scaledThreshold));
    return reducedThreshold < options.inputLength ? reducedThreshold : null;
}
function appendTestProviderEvent(event) {
    const logPath = process.env.SIFTKIT_TEST_PROVIDER_LOG_PATH;
    if (!logPath || !logPath.trim()) {
        return;
    }
    fs.appendFileSync(logPath, `${JSON.stringify(event)}\n`, { encoding: 'utf8' });
}
function extractPromptSection(prompt, header) {
    const escapedHeader = header.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    const pattern = new RegExp(`${escapedHeader}\\n([\\s\\S]*?)(?:\\n[A-Z][^\\n]*:\\n|$)`, 'u');
    const match = pattern.exec(prompt);
    return match ? match[1].trim() : '';
}
function toMockDecision(decision) {
    return JSON.stringify({
        classification: decision.classification,
        raw_review_required: decision.rawReviewRequired,
        output: decision.output,
    });
}
function buildMockDecision(prompt, question, phase) {
    const inputText = extractPromptSection(prompt, 'Input:');
    if (!inputText.trim() || /unsupported fixture marker/u.test(inputText)) {
        return {
            classification: 'unsupported_input',
            rawReviewRequired: false,
            output: exports.UNSUPPORTED_INPUT_MESSAGE,
        };
    }
    if (/Return only valid JSON/u.test(prompt)) {
        return {
            classification: 'summary',
            rawReviewRequired: false,
            output: '[{"package":"lodash","severity":"high","title":"demo","fix_version":"1.0.0"}]',
        };
    }
    if (/Could not find type "Active_Buffs"/u.test(inputText)) {
        return {
            classification: 'summary',
            rawReviewRequired: true,
            output: 'The smoke run is failing during script compilation. The decisive failure is parse errors in Global.gd for missing types like Active_Buffs, Bases, and Infos.\nRaw review required.',
        };
    }
    if (/TARGET_VALID/u.test(inputText) && /resources still in use at exit/u.test(inputText)) {
        return {
            classification: 'summary',
            rawReviewRequired: true,
            output: 'The run passed numerically but is still not clean. Shutdown integrity failed because the log includes freed-object script errors and resources still in use at exit.\nRaw review required.',
        };
    }
    if (/ACTION_VALIDATE_FAIL/u.test(inputText) && /warp\/set_stay_100pct/u.test(inputText)) {
        return {
            classification: 'summary',
            rawReviewRequired: true,
            output: 'This run failed autonomous-mode validation. The decisive failure is warp/set_stay_100pct because the stay threshold was not set to 100%.\nRaw review required.',
        };
    }
    if (/save_file_loaded/u.test(inputText) && /Global\.gd/u.test(inputText)) {
        return {
            classification: 'summary',
            rawReviewRequired: true,
            output: 'This run is not clean. The log contains repeated script errors on Global.gd, including invalid access to save_file_loaded, Drones, Motherships, and KEY_EXPORT.\nRaw review required.',
        };
    }
    if ((/TEST HARNESS:/u.test(inputText) && /0 failed/u.test(inputText)) || /pass markers alone do not prove/u.test(inputText)) {
        return {
            classification: 'summary',
            rawReviewRequired: true,
            output: 'These logs show explicit numeric pass markers in historical runs. Pass markers alone do not prove the runs were clean because other logs in the same set can still contain script errors or shutdown issues.\nRaw review required.',
        };
    }
    if (phase === 'merge' || question.startsWith('Merge these partial summaries into one final answer')) {
        if (/pass markers alone do not prove|numeric pass markers/i.test(inputText)) {
            return {
                classification: 'summary',
                rawReviewRequired: true,
                output: 'These logs show explicit numeric pass markers in historical runs. Pass markers alone do not prove the runs were clean because other logs in the same set can still contain script errors or shutdown issues.\nRaw review required.',
            };
        }
        if (/run is not clean|script errors/i.test(inputText)) {
            return {
                classification: 'summary',
                rawReviewRequired: true,
                output: 'This run is not clean. The log contains repeated script errors and related runtime failures.\nRaw review required.',
            };
        }
        if (/failed autonomous-mode validation|stay threshold/i.test(inputText)) {
            return {
                classification: 'summary',
                rawReviewRequired: true,
                output: 'This run failed autonomous-mode validation. The decisive failure is warp/set_stay_100pct because the stay threshold was not set to 100%.\nRaw review required.',
            };
        }
        if (/shutdown integrity failed|resources still in use at exit/i.test(inputText)) {
            return {
                classification: 'summary',
                rawReviewRequired: true,
                output: 'The run passed numerically but is still not clean. Shutdown integrity failed because the log includes freed-object script errors and resources still in use at exit.\nRaw review required.',
            };
        }
        if (/failing during script compilation|parse errors/i.test(inputText)) {
            return {
                classification: 'summary',
                rawReviewRequired: true,
                output: 'The smoke run is failing during script compilation. The decisive failure is parse errors in Global.gd for missing types like Active_Buffs, Bases, and Infos.\nRaw review required.',
            };
        }
    }
    if (/Unable to resolve external command/u.test(inputText) || /is not recognized as an internal or external command/u.test(inputText)) {
        return {
            classification: 'command_failure',
            rawReviewRequired: true,
            output: 'The command failed before producing a usable result. The executable could not be resolved in the current environment.\nRaw review required.',
        };
    }
    if (/did tests pass/u.test(question)) {
        return {
            classification: 'summary',
            rawReviewRequired: true,
            output: 'Tests did not pass cleanly. The decisive failures are test_order_processing and test_auth_timeout.\nRaw review required.',
        };
    }
    if (/resources added, changed, and destroyed/u.test(question)) {
        return {
            classification: 'summary',
            rawReviewRequired: true,
            output: 'This output includes a destructive infrastructure change. The decisive action is destroy aws_db_instance.main.\nRaw review required.',
        };
    }
    return {
        classification: 'summary',
        rawReviewRequired: false,
        output: 'mock summary',
    };
}
function getMockSummary(prompt, question, phase) {
    const behavior = process.env.SIFTKIT_TEST_PROVIDER_BEHAVIOR?.trim() || '';
    if (behavior === 'throw') {
        throw new Error('mock provider failure');
    }
    if (behavior === 'recursive-merge') {
        if (phase === 'merge' || question.startsWith('Merge these partial summaries into one final answer')) {
            return toMockDecision({
                classification: 'summary',
                rawReviewRequired: false,
                output: 'merge summary',
            });
        }
        return toMockDecision({
            classification: 'summary',
            rawReviewRequired: false,
            output: 'L'.repeat(150000),
        });
    }
    const token = process.env.SIFTKIT_TEST_TOKEN;
    const decision = buildMockDecision(prompt, question, phase);
    if (token && decision.output === 'mock summary') {
        decision.output = `mock summary ${token}`;
    }
    return toMockDecision(decision);
}
async function invokeProviderSummary(options) {
    await (0, config_js_1.notifyStatusBackend)({
        running: true,
        promptCharacterCount: options.promptCharacterCount,
        rawInputCharacterCount: options.rawInputCharacterCount,
        chunkInputCharacterCount: options.chunkInputCharacterCount,
        budgetSource: options.config.Effective?.BudgetSource ?? null,
        inputCharactersPerContextToken: options.config.Effective?.InputCharactersPerContextToken ?? null,
        chunkThresholdCharacters: options.config.Effective?.ChunkThresholdCharacters ?? null,
        phase: options.phase,
        chunkIndex: options.chunkIndex,
        chunkTotal: options.chunkTotal,
        chunkPath: options.chunkPath,
    });
    const startedAt = Date.now();
    let inputTokens = null;
    let outputCharacterCount = null;
    let outputTokens = null;
    let thinkingTokens = null;
    try {
        if (options.backend === 'mock') {
            const rawSleep = process.env.SIFTKIT_TEST_PROVIDER_SLEEP_MS;
            const sleepMs = rawSleep ? Number.parseInt(rawSleep, 10) : 0;
            if (Number.isFinite(sleepMs) && sleepMs > 0) {
                await new Promise((resolve) => setTimeout(resolve, sleepMs));
            }
            appendTestProviderEvent({
                backend: options.backend,
                model: options.model,
                phase: options.phase,
                question: options.question,
                rawInputCharacterCount: options.rawInputCharacterCount,
                chunkInputCharacterCount: options.chunkInputCharacterCount,
            });
            const mockSummary = getMockSummary(options.prompt, options.question, options.phase);
            outputCharacterCount = mockSummary.length;
            return mockSummary;
        }
        const response = await (0, llama_cpp_js_1.generateLlamaCppResponse)({
            config: options.config,
            model: options.model,
            prompt: options.prompt,
            timeoutSeconds: 600,
            overrides: options.llamaCppOverrides,
        });
        inputTokens = response.usage?.promptTokens ?? null;
        outputCharacterCount = response.text.length;
        outputTokens = response.usage?.completionTokens ?? null;
        thinkingTokens = response.usage?.thinkingTokens ?? null;
        return response.text.trim();
    }
    finally {
        await (0, config_js_1.notifyStatusBackend)({
            running: false,
            promptCharacterCount: options.promptCharacterCount,
            inputTokens,
            outputCharacterCount,
            outputTokens,
            thinkingTokens,
            requestDurationMs: Date.now() - startedAt,
        });
    }
}
function getSourceInstructions(sourceKind, commandExitCode) {
    if (sourceKind === 'command-output') {
        const exitCodeLine = commandExitCode === null || commandExitCode === undefined
            ? 'Command exit code: unknown.'
            : `Command exit code: ${commandExitCode}.`;
        return [
            'Input kind: command output from the current environment.',
            exitCodeLine,
            'Decide whether the command itself failed or whether it succeeded and the output is reporting application/log/runtime failures.',
            'Use classification "command_failure" only when the command/input itself failed or the output is unsupported/unusable for the requested question.',
        ].join('\n');
    }
    return [
        'Input kind: standalone text or captured log review.',
        'Treat this as content to analyze, not as a live command execution result.',
        'Use classification "summary" unless the input is unsupported or unusable for the requested question.',
    ].join('\n');
}
function buildPrompt(options) {
    const profilePrompt = PROMPT_PROFILES[options.policyProfile] || PROMPT_PROFILES.general;
    const rawReviewPrompt = options.rawReviewRequired
        ? 'Raw-log review is likely required. Set raw_review_required to true unless the input clearly proves otherwise.'
        : 'Set raw_review_required based on the evidence. Use true for risky, incomplete, or failure-related output.';
    const outputFormatPrompt = options.format === 'json'
        ? 'The output field must be valid JSON text, not markdown.'
        : 'The output field must be concise plain text with the conclusion first.';
    const phasePrompt = options.phase === 'merge'
        ? 'You are merging chunk-level SiftKit decisions into one final decision for the original question.'
        : 'You are SiftKit, a conservative shell-output compressor for Codex workflows.';
    const sections = [
        phasePrompt,
        '',
        'Rules:',
        '- Preserve the most decisive facts.',
        '- Prefer conclusion-first synthesis over raw extraction.',
        '- Never claim certainty beyond the input.',
        '- If evidence is incomplete or ambiguous, say so.',
        '- Do not suggest destructive actions.',
        '- Return only a valid JSON object. No markdown fences.',
        '',
        'Classification schema:',
        '- "summary": the input is usable and should be summarized normally.',
        '- "command_failure": the command/input itself failed and that failure should be reported.',
        `- "unsupported_input": the input is unsupported or unusable; output must be exactly "${exports.UNSUPPORTED_INPUT_MESSAGE}".`,
        '',
        'Response JSON shape:',
        '{"classification":"summary|command_failure|unsupported_input","raw_review_required":true,"output":"final answer text"}',
        '',
        'Source handling:',
        getSourceInstructions(options.sourceKind || 'standalone', options.commandExitCode),
        '',
        'Profile:',
        profilePrompt,
        '',
        'Output requirements:',
        outputFormatPrompt,
        'If raw_review_required is true and classification is not "unsupported_input", include the exact sentence "Raw review required." in the output.',
        '',
        'Risk handling:',
        rawReviewPrompt,
        '',
        'Question:',
        options.question,
        '',
        'Input:',
        options.inputText,
    ];
    const promptPrefix = options.promptPrefix?.trim();
    return promptPrefix
        ? [promptPrefix, '', ...sections].join('\n')
        : sections.join('\n');
}
function stripCodeFence(text) {
    const trimmed = text.trim();
    const fenceMatch = /^```(?:json)?\s*([\s\S]*?)\s*```$/u.exec(trimmed);
    return fenceMatch ? fenceMatch[1].trim() : trimmed;
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
    const output = parsed.output;
    if (typeof output !== 'string' || !output.trim()) {
        throw new Error('Provider returned an empty SiftKit decision output.');
    }
    return {
        classification: classification,
        rawReviewRequired: Boolean(parsed.raw_review_required ?? parsed.rawReviewRequired ?? false),
        output: output.trim(),
    };
}
function ensureRawReviewSentence(decision, format) {
    if (!decision.rawReviewRequired || decision.classification === 'unsupported_input' || format === 'json') {
        return decision;
    }
    if (/\bRaw review required\./u.test(decision.output)) {
        return decision;
    }
    return {
        ...decision,
        output: `${decision.output.trim()}\nRaw review required.`,
    };
}
function normalizeStructuredDecision(decision, format) {
    if (decision.classification === 'unsupported_input') {
        return {
            classification: 'unsupported_input',
            rawReviewRequired: false,
            output: exports.UNSUPPORTED_INPUT_MESSAGE,
        };
    }
    return ensureRawReviewSentence(decision, format);
}
function appendChunkPath(parentPath, chunkIndex, chunkTotal) {
    const segment = `${chunkIndex}/${chunkTotal}`;
    return parentPath && parentPath.trim()
        ? `${parentPath.trim()} -> ${segment}`
        : segment;
}
async function invokeSummaryCore(options) {
    const rootInputCharacterCount = options.rootInputCharacterCount ?? options.inputText.length;
    const phase = options.phase ?? 'leaf';
    const chunkThreshold = Math.max(1, Math.floor(options.chunkThresholdOverride ?? (0, config_js_1.getChunkThresholdCharacters)(options.config)));
    if (options.inputText.length > chunkThreshold) {
        const chunks = (options.backend === 'llama.cpp'
            ? await planTokenAwareLlamaCppChunks({
                question: options.question,
                inputText: options.inputText,
                format: options.format,
                policyProfile: options.policyProfile,
                rawReviewRequired: options.rawReviewRequired,
                promptPrefix: options.promptPrefix,
                sourceKind: options.sourceKind,
                commandExitCode: options.commandExitCode,
                config: options.config,
                chunkThreshold,
                phase,
            })
            : null) ?? splitTextIntoChunks(options.inputText, chunkThreshold);
        const chunkDecisions = [];
        for (let index = 0; index < chunks.length; index += 1) {
            const decision = await invokeSummaryCore({
                ...options,
                inputText: chunks[index],
                rootInputCharacterCount,
                phase,
                chunkIndex: index + 1,
                chunkTotal: chunks.length,
                chunkPath: appendChunkPath(options.chunkPath ?? null, index + 1, chunks.length),
            });
            chunkDecisions.push(decision);
        }
        const mergeSections = [];
        for (let index = 0; index < chunkDecisions.length; index += 1) {
            mergeSections.push(`Chunk ${index + 1}:`);
            mergeSections.push(`classification=${chunkDecisions[index].classification}`);
            mergeSections.push(`raw_review_required=${chunkDecisions[index].rawReviewRequired}`);
            mergeSections.push(chunkDecisions[index].output);
            if (index < chunkDecisions.length - 1) {
                mergeSections.push('');
            }
        }
        return invokeSummaryCore({
            ...options,
            question: `Merge these partial summaries into one final answer for the original question: ${options.question}`,
            inputText: mergeSections.join('\n'),
            rawReviewRequired: options.rawReviewRequired || chunkDecisions.some((decision) => decision.rawReviewRequired),
            rootInputCharacterCount,
            phase: 'merge',
            chunkIndex: null,
            chunkTotal: null,
            chunkPath: null,
        });
    }
    const prompt = buildPrompt({
        question: options.question,
        inputText: options.inputText,
        format: options.format,
        policyProfile: options.policyProfile,
        rawReviewRequired: options.rawReviewRequired,
        promptPrefix: options.promptPrefix,
        sourceKind: options.sourceKind,
        commandExitCode: options.commandExitCode,
        phase,
    });
    const effectivePromptLimit = options.backend === 'llama.cpp'
        ? (0, config_js_1.getConfiguredLlamaNumCtx)(options.config) - LLAMA_CPP_PROMPT_TOKEN_RESERVE
        : null;
    const promptTokenCount = effectivePromptLimit !== null && effectivePromptLimit > 0
        ? await (0, llama_cpp_js_1.countLlamaCppTokens)(options.config, prompt)
        : null;
    const preflightChunkThreshold = effectivePromptLimit !== null && promptTokenCount !== null
        ? getTokenAwareChunkThreshold({
            inputLength: options.inputText.length,
            promptTokenCount,
            effectivePromptLimit,
        })
        : null;
    if (preflightChunkThreshold !== null) {
        return invokeSummaryCore({
            ...options,
            chunkThresholdOverride: preflightChunkThreshold,
            chunkIndex: options.chunkIndex ?? null,
            chunkTotal: options.chunkTotal ?? null,
            chunkPath: options.chunkPath ?? null,
        });
    }
    try {
        const rawResponse = await invokeProviderSummary({
            backend: options.backend,
            config: options.config,
            model: options.model,
            prompt,
            question: options.question,
            promptCharacterCount: prompt.length,
            rawInputCharacterCount: rootInputCharacterCount,
            chunkInputCharacterCount: options.inputText.length,
            phase,
            chunkIndex: options.chunkIndex ?? null,
            chunkTotal: options.chunkTotal ?? null,
            chunkPath: options.chunkPath ?? null,
            llamaCppOverrides: options.llamaCppOverrides,
        });
        return normalizeStructuredDecision(parseStructuredModelDecision(rawResponse), options.format);
    }
    catch (error) {
        if (!shouldRetryWithSmallerChunks({
            error,
            backend: options.backend,
            inputText: options.inputText,
            chunkThreshold,
        })) {
            throw error;
        }
        const reducedThreshold = (effectivePromptLimit !== null && promptTokenCount !== null
            ? getTokenAwareChunkThreshold({
                inputLength: options.inputText.length,
                promptTokenCount,
                effectivePromptLimit,
            })
            : null) ?? Math.max(1, Math.min(chunkThreshold - 1, Math.floor(options.inputText.length / 2)));
        if (reducedThreshold >= options.inputText.length) {
            throw error;
        }
        return invokeSummaryCore({
            ...options,
            chunkThresholdOverride: reducedThreshold,
            chunkIndex: options.chunkIndex ?? null,
            chunkTotal: options.chunkTotal ?? null,
            chunkPath: options.chunkPath ?? null,
        });
    }
}
function getPolicyDecision(classification) {
    if (classification === 'command_failure') {
        return 'model-command-failure';
    }
    if (classification === 'unsupported_input') {
        return 'model-unsupported-input';
    }
    return 'model-summary';
}
async function summarizeRequest(request) {
    const inputText = normalizeInputText(request.inputText);
    if (!inputText || !inputText.trim()) {
        throw new Error('Provide --text, --file, or pipe input into siftkit.');
    }
    return (0, execution_lock_js_1.withExecutionLock)(async () => {
        const config = await (0, config_js_1.loadConfig)({ ensure: true });
        (0, config_js_1.getConfiguredLlamaBaseUrl)(config);
        (0, config_js_1.getConfiguredLlamaNumCtx)(config);
        const backend = request.backend || config.Backend;
        const model = request.model || (0, config_js_1.getConfiguredModel)(config);
        const riskLevel = request.policyProfile === 'risky-operation' ? 'risky' : 'informational';
        const decision = getSummaryDecision(inputText, request.question, riskLevel, config);
        const effectivePromptPrefix = request.promptPrefix !== undefined
            ? request.promptPrefix
            : (0, config_js_1.getConfiguredPromptPrefix)(config);
        const modelDecision = await invokeSummaryCore({
            question: request.question,
            inputText,
            format: request.format,
            policyProfile: request.policyProfile,
            backend,
            model,
            config,
            rawReviewRequired: decision.RawReviewRequired,
            sourceKind: request.sourceKind || 'standalone',
            commandExitCode: request.commandExitCode,
            promptPrefix: effectivePromptPrefix,
            llamaCppOverrides: request.llamaCppOverrides,
        });
        return {
            WasSummarized: modelDecision.classification !== 'unsupported_input',
            PolicyDecision: getPolicyDecision(modelDecision.classification),
            Backend: backend,
            Model: model,
            Summary: modelDecision.output.trim(),
            Classification: modelDecision.classification,
            RawReviewRequired: modelDecision.rawReviewRequired,
            ModelCallSucceeded: true,
            ProviderError: null,
        };
    });
}
function readSummaryInput(options) {
    if (options.text !== undefined) {
        return normalizeInputText(options.text);
    }
    if (options.file) {
        if (!fs.existsSync(options.file)) {
            if (options.stdinText !== undefined) {
                return normalizeInputText(options.stdinText);
            }
            throw new Error(`Input file not found: ${options.file}`);
        }
        return normalizeInputText(fs.readFileSync(options.file, 'utf8'));
    }
    if (options.stdinText !== undefined) {
        return normalizeInputText(options.stdinText);
    }
    return null;
}
