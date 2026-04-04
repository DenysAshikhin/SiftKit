"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.truncatePlannerText = exports.formatPlannerToolResultTokenGuardError = exports.formatPlannerToolResultHeader = exports.formatPlannerResult = exports.formatNumberedLineBlock = exports.formatCompactJsonBlock = void 0;
exports.getPlannerToolName = getPlannerToolName;
exports.escapeUnescapedRegexBraces = escapeUnescapedRegexBraces;
exports.buildPlannerToolDefinitions = buildPlannerToolDefinitions;
exports.executePlannerTool = executePlannerTool;
const errors_js_1 = require("../../lib/errors.js");
const formatters_js_1 = require("./formatters.js");
Object.defineProperty(exports, "formatCompactJsonBlock", { enumerable: true, get: function () { return formatters_js_1.formatCompactJsonBlock; } });
Object.defineProperty(exports, "formatNumberedLineBlock", { enumerable: true, get: function () { return formatters_js_1.formatNumberedLineBlock; } });
Object.defineProperty(exports, "formatPlannerResult", { enumerable: true, get: function () { return formatters_js_1.formatPlannerResult; } });
Object.defineProperty(exports, "formatPlannerToolResultHeader", { enumerable: true, get: function () { return formatters_js_1.formatPlannerToolResultHeader; } });
Object.defineProperty(exports, "formatPlannerToolResultTokenGuardError", { enumerable: true, get: function () { return formatters_js_1.formatPlannerToolResultTokenGuardError; } });
Object.defineProperty(exports, "truncatePlannerText", { enumerable: true, get: function () { return formatters_js_1.truncatePlannerText; } });
const json_filter_js_1 = require("./json-filter.js");
function getPlannerToolName(value) {
    return value === 'find_text' || value === 'read_lines' || value === 'json_filter'
        ? value
        : null;
}
function isRegexCharEscaped(text, index) {
    let slashCount = 0;
    for (let cursor = index - 1; cursor >= 0 && text[cursor] === '\\'; cursor -= 1) {
        slashCount += 1;
    }
    return slashCount % 2 === 1;
}
function escapeUnescapedRegexBraces(query) {
    let normalized = '';
    for (let index = 0; index < query.length; index += 1) {
        const char = query[index];
        if ((char === '{' || char === '}') && !isRegexCharEscaped(query, index)) {
            normalized += `\\${char}`;
            continue;
        }
        normalized += char;
    }
    return normalized;
}
function buildPlannerToolDefinitions() {
    return [
        {
            type: 'function',
            function: {
                name: 'find_text',
                description: 'Search the input text for a literal string or regex and return matching lines with optional surrounding context. Regex patterns must be valid JavaScript regex source without surrounding slashes; do not escape ordinary quotes unless the regex itself requires it. Example: {"query":"Lumbridge","mode":"literal","maxHits":5,"contextLines":1}',
                parameters: {
                    type: 'object',
                    properties: {
                        query: { type: 'string', description: 'The literal text or regex pattern to search for.' },
                        mode: { type: 'string', enum: ['literal', 'regex'], description: 'Whether query is treated as literal text or regex.' },
                        maxHits: { type: 'integer', description: 'Maximum number of matching locations to return.' },
                        contextLines: { type: 'integer', description: 'Number of surrounding lines to include before and after each hit.' },
                    },
                    required: ['query', 'mode'],
                },
            },
        },
        {
            type: 'function',
            function: {
                name: 'read_lines',
                description: 'Read a specific 1-based line range from the input text. Example: {"startLine":1340,"endLine":1405}',
                parameters: {
                    type: 'object',
                    properties: {
                        startLine: { type: 'integer', description: 'Inclusive 1-based start line.' },
                        endLine: { type: 'integer', description: 'Inclusive 1-based end line.' },
                    },
                    required: ['startLine', 'endLine'],
                },
            },
        },
        {
            type: 'function',
            function: {
                name: 'json_filter',
                description: 'Parse JSON, filter array items by field conditions, and project only the selected fields. Use collectionPath when the root JSON value is an object with an array under a child key; for example use {"collectionPath":"states","filters":[{"path":"timestamp","op":"gte","value":"2026-03-30T18:40:00Z"},{"path":"timestamp","op":"lte","value":"2026-03-30T18:50:00Z"}],"select":["timestamp","lifecycle_state","bridge_state","scenario_id","step_id","state_json"],"limit":100} for a root object with a states array. Use separate filters for gte/lte bounds; each filter value should be a single scalar value, not an object containing multiple operators. Do not use "value":{"gte":3200,"lte":3215}. Example: {"filters":[{"path":"from.worldX","op":"gte","value":3200},{"path":"from.worldX","op":"lte","value":3215}],"select":["id","label","from","to","bidirectional"],"limit":20}',
                parameters: {
                    type: 'object',
                    properties: {
                        collectionPath: { type: 'string', description: 'Optional dot-path to the array collection. Omit for a root array.' },
                        filters: {
                            type: 'array',
                            description: 'Field predicates applied to each item in the collection.',
                            items: {
                                type: 'object',
                                properties: {
                                    path: { type: 'string' },
                                    op: { type: 'string', enum: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains', 'exists'] },
                                    value: {},
                                },
                                required: ['path', 'op'],
                            },
                        },
                        select: {
                            type: 'array',
                            description: 'Optional list of dot-path fields to project from each matched item.',
                            items: { type: 'string' },
                        },
                        limit: { type: 'integer', description: 'Maximum number of matched items to return.' },
                    },
                    required: ['filters'],
                },
            },
        },
    ];
}
function executeFindTextTool(inputText, args) {
    const query = typeof args.query === 'string' ? args.query : '';
    const mode = args.mode === 'regex' ? 'regex' : args.mode === 'literal' ? 'literal' : null;
    if (!query.trim() || !mode) {
        throw new Error('find_text requires query and mode.');
    }
    const maxHits = Math.max(1, Math.min((0, json_filter_js_1.getFiniteInteger)(args.maxHits) ?? 5, 20));
    const contextLines = Math.max(0, Math.min((0, json_filter_js_1.getFiniteInteger)(args.contextLines) ?? 0, 3));
    const lines = inputText.replace(/\r\n/gu, '\n').split('\n');
    let matcher = null;
    let normalizedQuery = null;
    if (mode === 'regex') {
        try {
            matcher = new RegExp(query, 'u');
        }
        catch (error) {
            const escapedBraceQuery = escapeUnescapedRegexBraces(query);
            if (escapedBraceQuery !== query) {
                try {
                    matcher = new RegExp(escapedBraceQuery, 'u');
                    normalizedQuery = escapedBraceQuery;
                }
                catch {
                    // Preserve original parser error below when fallback still fails.
                }
            }
            if (!matcher) {
                const errorText = `find_text invalid regex: ${(0, errors_js_1.getErrorMessage)(error)}.`;
                return {
                    tool: 'find_text',
                    mode,
                    query,
                    hitCount: 0,
                    error: errorText,
                    text: errorText,
                };
            }
        }
    }
    const hitBlocks = [];
    let hitCount = 0;
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        const matched = mode === 'literal'
            ? line.includes(query)
            : Boolean(matcher?.test(line));
        if (!matched) {
            continue;
        }
        hitCount += 1;
        const start = Math.max(0, index - contextLines);
        const end = Math.min(lines.length - 1, index + contextLines);
        hitBlocks.push((0, formatters_js_1.formatNumberedLineBlock)(lines.slice(start, end + 1), start + 1));
        if (hitCount >= maxHits) {
            break;
        }
    }
    return {
        tool: 'find_text',
        mode,
        query,
        normalizedQuery,
        hitCount,
        text: hitBlocks.join('\n\n'),
    };
}
function executeReadLinesTool(inputText, args) {
    const startLine = Math.max((0, json_filter_js_1.getFiniteInteger)(args.startLine) ?? 1, 1);
    const endLine = Math.max((0, json_filter_js_1.getFiniteInteger)(args.endLine) ?? startLine, startLine);
    const lines = inputText.replace(/\r\n/gu, '\n').split('\n');
    const clampedStart = Math.min(startLine, lines.length || 1);
    const clampedEnd = Math.min(endLine, lines.length || clampedStart);
    const selectedLines = lines.slice(clampedStart - 1, clampedEnd);
    return {
        tool: 'read_lines',
        startLine: clampedStart,
        endLine: clampedEnd,
        lineCount: selectedLines.length,
        text: (0, formatters_js_1.formatNumberedLineBlock)(selectedLines, clampedStart),
    };
}
function executeJsonFilterTool(inputText, args) {
    const parsedContext = (0, json_filter_js_1.parseJsonForJsonFilter)(inputText);
    const parsed = parsedContext.parsed;
    const filters = Array.isArray(args.filters)
        ? (0, json_filter_js_1.normalizeJsonFilterFilters)(args.filters.map((item) => (0, json_filter_js_1.getRecord)(item)).filter(Boolean))
        : [];
    if (filters.length === 0) {
        throw new Error('json_filter requires at least one filter.');
    }
    const collectionPath = typeof args.collectionPath === 'string' ? args.collectionPath : '';
    const collection = collectionPath ? (0, json_filter_js_1.getValueByPath)(parsed, collectionPath) : parsed;
    if (!Array.isArray(collection)) {
        throw new Error('json_filter collection is not an array.');
    }
    const select = Array.isArray(args.select)
        ? args.select.filter((value) => typeof value === 'string' && value.trim().length > 0)
        : null;
    const limit = Math.max(1, Math.min((0, json_filter_js_1.getFiniteInteger)(args.limit) ?? 10, 50));
    const matches = [];
    for (const item of collection) {
        if (!filters.every((filter) => (0, json_filter_js_1.matchesJsonFilter)(item, filter))) {
            continue;
        }
        matches.push((0, json_filter_js_1.projectJsonFilterItem)(item, select));
        if (matches.length >= limit) {
            break;
        }
    }
    return {
        tool: 'json_filter',
        collectionPath: collectionPath || '$',
        matchedCount: matches.length,
        usedFallback: parsedContext.usedFallback,
        ignoredPrefixPreview: parsedContext.usedFallback ? parsedContext.ignoredPrefixPreview : undefined,
        parsedSectionPreview: parsedContext.usedFallback ? parsedContext.parsedSectionPreview : undefined,
        text: (0, formatters_js_1.formatCompactJsonBlock)(matches),
    };
}
function executePlannerTool(inputText, action) {
    switch (action.tool_name) {
        case 'find_text':
            return executeFindTextTool(inputText, action.args);
        case 'read_lines':
            return executeReadLinesTool(inputText, action.args);
        case 'json_filter':
            return executeJsonFilterTool(inputText, action.args);
        default:
            throw new Error(`Unsupported planner tool: ${String(action.tool_name)}`);
    }
}
