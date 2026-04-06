"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_JSON_FALLBACK_PREVIEW_CHARACTERS = void 0;
exports.buildPlannerDocumentProfile = buildPlannerDocumentProfile;
exports.buildPlannerSystemPrompt = buildPlannerSystemPrompt;
exports.buildPlannerInitialUserPrompt = buildPlannerInitialUserPrompt;
exports.buildPlannerInvalidResponseUserPrompt = buildPlannerInvalidResponseUserPrompt;
exports.buildPlannerForcedFinishUserPrompt = buildPlannerForcedFinishUserPrompt;
exports.renderPlannerTranscript = renderPlannerTranscript;
exports.buildPlannerAssistantToolMessage = buildPlannerAssistantToolMessage;
const prompt_js_1 = require("../prompt.js");
const json_filter_js_1 = require("./json-filter.js");
Object.defineProperty(exports, "MAX_JSON_FALLBACK_PREVIEW_CHARACTERS", { enumerable: true, get: function () { return json_filter_js_1.MAX_JSON_FALLBACK_PREVIEW_CHARACTERS; } });
const formatters_js_1 = require("./formatters.js");
const MAX_PLANNER_PREVIEW_CHARACTERS = 600;
function buildPlannerDocumentProfile(inputText) {
    const lines = inputText.replace(/\r\n/gu, '\n').split('\n');
    const profileLines = [
        `chars=${inputText.length}`,
        `lines=${inputText.trim() ? lines.length : 0}`,
    ];
    const preview = (0, formatters_js_1.truncatePlannerText)(inputText.slice(0, MAX_PLANNER_PREVIEW_CHARACTERS));
    try {
        const parsed = JSON.parse(inputText);
        if (Array.isArray(parsed)) {
            profileLines.push('json=parseable');
            profileLines.push('top_level=array');
            profileLines.push(`array_length=${parsed.length}`);
            const sampleKeys = parsed.length > 0 && (0, json_filter_js_1.getRecord)(parsed[0])
                ? Object.keys((0, json_filter_js_1.getRecord)(parsed[0])).slice(0, 10)
                : [];
            if (sampleKeys.length > 0) {
                profileLines.push(`sample_keys=${sampleKeys.join(',')}`);
            }
        }
        else if ((0, json_filter_js_1.getRecord)(parsed)) {
            profileLines.push('json=parseable');
            profileLines.push('top_level=object');
            const parsedRecord = (0, json_filter_js_1.getRecord)(parsed);
            const objectKeys = Object.keys(parsedRecord).slice(0, 10);
            if (objectKeys.length > 0) {
                profileLines.push(`object_keys=${objectKeys.join(',')}`);
            }
            const objectArrayPaths = objectKeys.filter((key) => Array.isArray(parsedRecord[key]));
            if (objectArrayPaths.length > 0) {
                profileLines.push(`object_array_paths=${objectArrayPaths.join(',')}`);
                const firstArrayPath = objectArrayPaths[0];
                const firstArray = parsedRecord[firstArrayPath];
                const sampleItem = Array.isArray(firstArray) ? (0, json_filter_js_1.getRecord)(firstArray[0]) : null;
                if (sampleItem) {
                    const sampleItemKeys = Object.keys(sampleItem).slice(0, 10);
                    if (sampleItemKeys.length > 0) {
                        profileLines.push(`${firstArrayPath}_sample_keys=${sampleItemKeys.join(',')}`);
                    }
                }
            }
        }
        else {
            profileLines.push('json=parseable');
            profileLines.push(`top_level=${typeof parsed}`);
        }
    }
    catch {
        profileLines.push('json=unparseable');
        profileLines.push('top_level=text');
    }
    profileLines.push('preview:');
    profileLines.push(preview);
    return profileLines.join('\n');
}
function buildPlannerSystemPrompt(options) {
    const allowUnsupportedInput = options.sourceKind !== 'command-output';
    const sections = [
        'You are SiftKit, a conservative shell-output compressor for Codex workflows.',
        '',
        'Planner mode:',
        '- The full input is too large for a direct pass, so inspect only the minimum evidence needed.',
        '- If the document profile or current tool results are already sufficient, finish immediately.',
        '- Request at most one tool call per response.',
        '- Return only a valid JSON object. No markdown fences.',
        '- Use separate filters for gte/lte bounds in json_filter; do not combine multiple operators inside one filter value.',
        '- Do not use "value":{"gte":3200,"lte":3215}. Use one filter per bound with a scalar value.',
        '- When the document profile shows top_level=object with object_array_paths=..., use collectionPath to target that array and filter item fields relative to each array element.',
        '- Never emit JSON schema fragments like {"type":"integer"} as argument values. Use concrete literals.',
        '- Regex patterns must be valid JavaScript regex source for find_text. Do not add unnecessary escapes for ordinary quotes.',
        '',
        'Available actions:',
        '{"action":"tool","tool_name":"find_text|read_lines|json_filter","args":{...}}',
        allowUnsupportedInput
            ? '{"action":"finish","classification":"summary|command_failure|unsupported_input","raw_review_required":true|false,"output":"final answer text"}'
            : '{"action":"finish","classification":"summary|command_failure","raw_review_required":true|false,"output":"final answer text"}',
        '',
        'Example tool calls:',
        '{"action":"tool","tool_name":"find_text","args":{"query":"Lumbridge","mode":"literal","maxHits":5,"contextLines":1}}',
        '{"action":"tool","tool_name":"read_lines","args":{"startLine":1340,"endLine":1405}}',
        'Bad json_filter example: {"action":"tool","tool_name":"json_filter","args":{"filters":[{"path":"from.worldX","op":"gte","value":{"gte":3200,"lte":3215}}]}}',
        '{"action":"tool","tool_name":"json_filter","args":{"collectionPath":"states","filters":[{"path":"timestamp","op":"gte","value":"2026-03-30T18:40:00Z"},{"path":"timestamp","op":"lte","value":"2026-03-30T18:50:00Z"}],"select":["timestamp","lifecycle_state","bridge_state","scenario_id","step_id","state_json"],"limit":100}}',
        '{"action":"tool","tool_name":"json_filter","args":{"filters":[{"path":"from.worldX","op":"gte","value":3200},{"path":"from.worldX","op":"lte","value":3215},{"path":"from.worldY","op":"gte","value":3210},{"path":"from.worldY","op":"lte","value":3225}],"select":["id","label","type","from","to","bidirectional"],"limit":20}}',
        '',
        'Source handling:',
        (0, prompt_js_1.getSourceInstructions)(options.sourceKind, options.commandExitCode),
        '',
        'Risk handling:',
        options.rawReviewRequired
            ? 'Raw-log review is likely required. Set raw_review_required to true unless the visible evidence clearly proves otherwise.'
            : 'Set raw_review_required to false unless the output contains genuine errors, failures, or incomplete results that warrant manual inspection.',
        '',
        'Tools:',
        ...options.toolDefinitions.map((tool) => `${tool.function.name}: ${tool.function.description}`),
    ];
    const promptPrefix = options.promptPrefix?.trim();
    return promptPrefix
        ? [promptPrefix, '', ...sections].join('\n')
        : sections.join('\n');
}
function buildPlannerInitialUserPrompt(options) {
    return [
        'Document profile:',
        buildPlannerDocumentProfile(options.inputText),
        '',
        'Question:',
        options.question,
        '',
        'Use tools to inspect the full input when needed.',
    ].join('\n');
}
function buildPlannerInvalidResponseUserPrompt(message) {
    return [
        `Previous response was invalid: ${message.trim().replace(/\s+/gu, ' ')}`,
        'Retry with one corrected JSON action and concrete literal argument values.',
    ].join('\n');
}
function buildPlannerForcedFinishUserPrompt() {
    return [
        'You have used all available tool calls.',
        'Using only the evidence gathered so far, produce your final answer now.',
    ].join('\n');
}
function renderPlannerTranscript(messages) {
    return messages.map((message) => {
        const sections = [];
        if (typeof message.content === 'string' && message.content) {
            sections.push(message.content);
        }
        if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
            for (const toolCall of message.tool_calls) {
                sections.push(`Tool call: ${toolCall.function?.name ?? ''} ${String(toolCall.function?.arguments ?? '')}`.trim());
            }
        }
        if (message.role === 'tool' && typeof message.content === 'string' && message.content) {
            return `[tool]\nTool result:\n${message.content}`;
        }
        return sections.join('\n');
    }).join('\n\n');
}
function buildPlannerAssistantToolMessage(action, toolCallId) {
    return {
        role: 'assistant',
        content: '',
        tool_calls: [
            {
                id: toolCallId,
                type: 'function',
                function: {
                    name: action.tool_name,
                    arguments: JSON.stringify(action.args),
                },
            },
        ],
    };
}
