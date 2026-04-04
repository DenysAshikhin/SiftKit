"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.UNSUPPORTED_INPUT_MESSAGE = void 0;
exports.normalizeInputText = normalizeInputText;
exports.measureText = measureText;
exports.getQuestionAnalysis = getQuestionAnalysis;
exports.getErrorSignalMetrics = getErrorSignalMetrics;
exports.isPassFailQuestion = isPassFailQuestion;
exports.getDeterministicExcerpt = getDeterministicExcerpt;
exports.UNSUPPORTED_INPUT_MESSAGE = 'The command/input is either unsupported or failed. Please verify the command that it is supported in the current environment and returns proper input. If it does, raise an explicit error to the user and stop futher processing.';
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
function isPassFailQuestion(question) {
    const normalized = question ? question.toLowerCase() : '';
    return (/\bpass\/fail\b/u.test(normalized)
        || /\bpass or fail\b/u.test(normalized)
        || /\bexecute successfully\b/u.test(normalized)
        || /\bdid .* succeed\b/u.test(normalized)
        || /\bdid tests pass\b/u.test(normalized));
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
