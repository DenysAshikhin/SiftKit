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
exports.getDeterministicExcerpt = getDeterministicExcerpt;
exports.getSummaryDecision = getSummaryDecision;
exports.buildPrompt = buildPrompt;
exports.summarizeRequest = summarizeRequest;
exports.readSummaryInput = readSummaryInput;
const fs = __importStar(require("node:fs"));
const config_js_1 = require("./config.js");
const execution_lock_js_1 = require("./execution-lock.js");
const llama_cpp_js_1 = require("./providers/llama-cpp.js");
const PROMPT_PROFILES = {
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
        { pattern: /failing tests|did tests pass|what failed/u, reason: 'failure-triage' },
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
    const errorPattern = /\b(error|exception|traceback|failed|fatal|conflict|denied|panic|timed out|timeout)\b/iu;
    for (const line of lines) {
        if (!line.trim()) {
            continue;
        }
        nonEmptyLineCount += 1;
        if (errorPattern.test(line)) {
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
    const questionAnalysis = getQuestionAnalysis(question);
    const errorMetrics = getErrorSignalMetrics(text);
    const hasMaterialErrorSignals = (errorMetrics.ErrorLineCount > 0
        && (errorMetrics.NonEmptyLineCount <= 20
            || (errorMetrics.ErrorLineCount >= 5 && errorMetrics.ErrorRatio >= 0.25)
            || errorMetrics.ErrorRatio >= 0.25));
    if (questionAnalysis.IsExactDiagnosis || hasMaterialErrorSignals) {
        return {
            ShouldSummarize: false,
            Reason: questionAnalysis.IsExactDiagnosis ? 'raw-first-exact-diagnosis' : 'raw-first-error-signals',
            RawReviewRequired: true,
            CharacterCount: metrics.CharacterCount,
            LineCount: metrics.LineCount,
        };
    }
    if (metrics.CharacterCount < Number(config.Thresholds.MinCharactersForSummary)
        && metrics.LineCount < Number(config.Thresholds.MinLinesForSummary)) {
        return {
            ShouldSummarize: false,
            Reason: 'short-output',
            RawReviewRequired: false,
            CharacterCount: metrics.CharacterCount,
            LineCount: metrics.LineCount,
        };
    }
    if (riskLevel === 'debug' || riskLevel === 'risky') {
        return {
            ShouldSummarize: true,
            Reason: 'raw-first-secondary-summary',
            RawReviewRequired: true,
            CharacterCount: metrics.CharacterCount,
            LineCount: metrics.LineCount,
        };
    }
    return {
        ShouldSummarize: true,
        Reason: 'summarize',
        RawReviewRequired: false,
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
function appendTestProviderEvent(event) {
    const logPath = process.env.SIFTKIT_TEST_PROVIDER_LOG_PATH;
    if (!logPath || !logPath.trim()) {
        return;
    }
    fs.appendFileSync(logPath, `${JSON.stringify(event)}\n`, { encoding: 'utf8' });
}
function getMockSummary(prompt, question, phase) {
    const behavior = process.env.SIFTKIT_TEST_PROVIDER_BEHAVIOR?.trim() || '';
    if (behavior === 'throw') {
        throw new Error('mock provider failure');
    }
    if (behavior === 'recursive-merge') {
        if (phase === 'merge' || question.startsWith('Merge these partial summaries into one final answer')) {
            return 'merge summary';
        }
        return 'L'.repeat(150000);
    }
    if (/Return only valid JSON/u.test(prompt)) {
        return '[{"package":"lodash","severity":"high","title":"demo","fix_version":"1.0.0"}]';
    }
    if (/did tests pass/u.test(question)) {
        return 'test_order_processing failed and test_auth_timeout failed';
    }
    if (/resources added, changed, and destroyed/u.test(question)) {
        return 'destroy aws_db_instance.main; raw review required';
    }
    const token = process.env.SIFTKIT_TEST_TOKEN;
    return token ? `mock summary ${token}` : 'mock summary';
}
async function invokeProviderSummary(options) {
    await (0, config_js_1.notifyStatusBackend)({
        running: true,
        promptCharacterCount: options.promptCharacterCount,
        rawInputCharacterCount: options.rawInputCharacterCount,
        chunkInputCharacterCount: options.chunkInputCharacterCount,
        phase: options.phase,
        chunkIndex: options.chunkIndex,
        chunkTotal: options.chunkTotal,
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
function buildPrompt(options) {
    const profilePrompt = PROMPT_PROFILES[options.policyProfile] || PROMPT_PROFILES.general;
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
async function invokeSummaryCore(options) {
    const rootInputCharacterCount = options.rootInputCharacterCount ?? options.inputText.length;
    const phase = options.phase ?? 'leaf';
    const chunkThreshold = (0, config_js_1.getChunkThresholdCharacters)(options.config);
    if (options.inputText.length > chunkThreshold) {
        const chunks = splitTextIntoChunks(options.inputText, chunkThreshold);
        const chunkSummaries = [];
        for (let index = 0; index < chunks.length; index += 1) {
            const summary = await invokeSummaryCore({
                ...options,
                inputText: chunks[index],
                rootInputCharacterCount,
                phase,
                chunkIndex: index + 1,
                chunkTotal: chunks.length,
            });
            chunkSummaries.push(summary);
        }
        const mergeSections = [];
        for (let index = 0; index < chunkSummaries.length; index += 1) {
            mergeSections.push(`Summary of chunk ${index + 1}:`);
            mergeSections.push(chunkSummaries[index]);
            if (index < chunkSummaries.length - 1) {
                mergeSections.push('');
            }
        }
        return invokeSummaryCore({
            ...options,
            question: `Merge these partial summaries into one final answer for the original question: ${options.question}`,
            inputText: mergeSections.join('\n'),
            rootInputCharacterCount,
            phase: 'merge',
            chunkIndex: null,
            chunkTotal: null,
        });
    }
    const prompt = buildPrompt({
        question: options.question,
        inputText: options.inputText,
        format: options.format,
        policyProfile: options.policyProfile,
        rawReviewRequired: options.rawReviewRequired,
    });
    return invokeProviderSummary({
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
    });
}
async function summarizeRequest(request) {
    const inputText = normalizeInputText(request.inputText);
    if (!inputText || !inputText.trim()) {
        throw new Error('Provide --text, --file, or pipe input into siftkit.');
    }
    return (0, execution_lock_js_1.withExecutionLock)(async () => {
        const config = await (0, config_js_1.loadConfig)({ ensure: true });
        const backend = request.backend || config.Backend;
        const model = request.model || config.Model;
        const riskLevel = request.policyProfile === 'risky-operation' ? 'risky' : 'informational';
        const decision = getSummaryDecision(inputText, request.question, riskLevel, config);
        const deterministicExcerpt = getDeterministicExcerpt(inputText, request.question);
        if (!decision.ShouldSummarize) {
            const summaryText = deterministicExcerpt
                ? `Raw review required.\n${deterministicExcerpt}`
                : (decision.RawReviewRequired ? `Raw review required.\n${inputText}` : inputText);
            return {
                WasSummarized: false,
                PolicyDecision: decision.Reason,
                Backend: backend,
                Model: model,
                Summary: summaryText,
            };
        }
        const summary = await invokeSummaryCore({
            question: request.question,
            inputText,
            format: request.format,
            policyProfile: request.policyProfile,
            backend,
            model,
            config,
            rawReviewRequired: decision.RawReviewRequired,
        });
        return {
            WasSummarized: true,
            PolicyDecision: decision.Reason,
            Backend: backend,
            Model: model,
            Summary: summary.trim(),
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
