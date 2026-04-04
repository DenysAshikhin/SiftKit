"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.stripCodeFence = stripCodeFence;
exports.decodeStructuredOutputText = decodeStructuredOutputText;
exports.tryRecoverStructuredModelDecision = tryRecoverStructuredModelDecision;
exports.parseStructuredModelDecision = parseStructuredModelDecision;
exports.ensureRawReviewSentence = ensureRawReviewSentence;
exports.normalizeStructuredDecision = normalizeStructuredDecision;
exports.buildConservativeChunkFallbackDecision = buildConservativeChunkFallbackDecision;
exports.buildConservativeDirectFallbackDecision = buildConservativeDirectFallbackDecision;
exports.isInternalChunkLeaf = isInternalChunkLeaf;
const measure_js_1 = require("./measure.js");
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
            output: measure_js_1.UNSUPPORTED_INPUT_MESSAGE,
        };
    }
    return ensureRawReviewSentence(decision, format);
}
function buildConservativeChunkFallbackDecision(options) {
    const excerpt = (0, measure_js_1.getDeterministicExcerpt)(options.inputText, options.question);
    const baseSummary = 'This internally generated chunk is a partial slice of a larger supported input. The slice may be truncated or malformed, so this summary is conservative and limited to visible evidence.';
    if (options.format === 'json') {
        return {
            classification: 'summary',
            rawReviewRequired: true,
            output: JSON.stringify({
                summary: baseSummary,
                visible_anchors: excerpt ? excerpt.split('\n').slice(0, 12) : [],
            }),
        };
    }
    return {
        classification: 'summary',
        rawReviewRequired: true,
        output: excerpt
            ? `${baseSummary}\nVisible anchors:\n${excerpt}`
            : baseSummary,
    };
}
function buildConservativeDirectFallbackDecision(options) {
    const excerpt = (0, measure_js_1.getDeterministicExcerpt)(options.inputText, options.question)
        || options.inputText.trim().split(/\r?\n/u).slice(0, 3).join('\n');
    const errorMetrics = (0, measure_js_1.getErrorSignalMetrics)(options.inputText);
    if (options.format === 'json') {
        return {
            classification: 'summary',
            rawReviewRequired: false,
            output: JSON.stringify({
                summary: 'Conservative local fallback: the input was non-empty and readable.',
                visible_anchors: excerpt ? excerpt.split('\n').slice(0, 12) : [],
            }),
        };
    }
    if (options.sourceKind === 'command-output' && (0, measure_js_1.isPassFailQuestion)(options.question)) {
        const status = errorMetrics.ErrorLineCount > 0 ? 'FAIL' : 'PASS';
        const detail = errorMetrics.ErrorLineCount > 0
            ? 'command output contains error signals'
            : 'command produced readable output with no obvious error signals';
        return {
            classification: 'summary',
            rawReviewRequired: false,
            output: excerpt ? `${status}: ${detail}. Observed output: ${excerpt}` : `${status}: ${detail}.`,
        };
    }
    return {
        classification: 'summary',
        rawReviewRequired: false,
        output: excerpt
            ? `Conservative local fallback: the input was non-empty and readable. Visible text: ${excerpt}`
            : 'Conservative local fallback: the input was non-empty and readable.',
    };
}
function isInternalChunkLeaf(options) {
    return options.phase === 'leaf' && options.chunkContext?.isGeneratedChunk === true;
}
