"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_PLANNER_TOOL_RESULT_CHARACTERS = void 0;
exports.truncatePlannerText = truncatePlannerText;
exports.formatNumberedLineBlock = formatNumberedLineBlock;
exports.formatCompactJsonBlock = formatCompactJsonBlock;
exports.formatPlannerToolResultHeader = formatPlannerToolResultHeader;
exports.formatPlannerResult = formatPlannerResult;
exports.formatPlannerToolResultTokenGuardError = formatPlannerToolResultTokenGuardError;
const json_filter_js_1 = require("./json-filter.js");
exports.MAX_PLANNER_TOOL_RESULT_CHARACTERS = 12_000;
function truncatePlannerText(text) {
    if (text.length <= exports.MAX_PLANNER_TOOL_RESULT_CHARACTERS) {
        return text;
    }
    return `${text.slice(0, exports.MAX_PLANNER_TOOL_RESULT_CHARACTERS)}\n... [truncated ${text.length - exports.MAX_PLANNER_TOOL_RESULT_CHARACTERS} chars]`;
}
function formatNumberedLineBlock(lines, startLine) {
    return lines
        .map((line, index) => `${startLine + index}: ${line}`)
        .join('\n');
}
function formatCompactJsonBlock(values) {
    return values.map((value) => JSON.stringify(value)).join('\n');
}
function formatPlannerToolResultHeader(value) {
    const tool = typeof value.tool === 'string' ? value.tool : '';
    if (tool === 'read_lines') {
        return `read_lines startLine=${value.startLine} endLine=${value.endLine} lineCount=${value.lineCount}`;
    }
    if (tool === 'find_text') {
        return `find_text mode=${value.mode} query=${JSON.stringify(value.query)} hitCount=${value.hitCount}`;
    }
    if (tool === 'json_filter') {
        const base = `json_filter collectionPath=${value.collectionPath} matchedCount=${value.matchedCount}`;
        const usedFallback = value.usedFallback === true;
        if (!usedFallback) {
            return base;
        }
        const ignoredPrefixPreview = typeof value.ignoredPrefixPreview === 'string'
            ? value.ignoredPrefixPreview
            : '';
        const parsedSectionPreview = typeof value.parsedSectionPreview === 'string'
            ? value.parsedSectionPreview
            : '';
        return `${base}\njson_filter ignored "${ignoredPrefixPreview}" due to not being valid json, here is the parsed valid section: "${parsedSectionPreview}"`;
    }
    return null;
}
function formatPlannerResult(value) {
    const record = (0, json_filter_js_1.getRecord)(value);
    if (record && typeof record.text === 'string') {
        const header = formatPlannerToolResultHeader(record);
        return truncatePlannerText(header ? `${header}\n${record.text}` : record.text);
    }
    return truncatePlannerText(JSON.stringify(value, null, 2));
}
function formatPlannerToolResultTokenGuardError(resultTokens) {
    return `Error: tool call results in ${resultTokens} tokens (more than 70% of remaining tokens). Try again with a more limited tool call)`;
}
