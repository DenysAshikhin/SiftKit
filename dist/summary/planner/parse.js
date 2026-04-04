"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parsePlannerAction = parsePlannerAction;
const errors_js_1 = require("../../lib/errors.js");
const structured_js_1 = require("../structured.js");
const json_filter_js_1 = require("./json-filter.js");
const tools_js_1 = require("./tools.js");
function parsePlannerAction(text) {
    let parsed;
    try {
        parsed = JSON.parse((0, structured_js_1.stripCodeFence)(text));
    }
    catch (error) {
        throw new Error(`Provider returned an invalid planner payload: ${(0, errors_js_1.getErrorMessage)(error)}`);
    }
    const action = typeof parsed.action === 'string' ? parsed.action.trim().toLowerCase() : '';
    if (action === 'tool') {
        const toolName = (0, tools_js_1.getPlannerToolName)(parsed.tool_name);
        const args = (0, json_filter_js_1.getRecord)(parsed.args);
        if (!toolName || !args) {
            throw new Error('Provider returned an invalid planner tool action.');
        }
        return {
            action: 'tool',
            tool_name: toolName,
            args,
        };
    }
    if (action === 'finish') {
        const classification = typeof parsed.classification === 'string'
            ? parsed.classification.trim().toLowerCase()
            : '';
        const output = typeof parsed.output === 'string' ? parsed.output.trim() : '';
        if (!['summary', 'command_failure', 'unsupported_input'].includes(classification) || !output) {
            throw new Error('Provider returned an invalid planner finish action.');
        }
        return {
            action: 'finish',
            classification: classification,
            rawReviewRequired: Boolean(parsed.raw_review_required ?? parsed.rawReviewRequired ?? false),
            output,
        };
    }
    throw new Error('Provider returned an unknown planner action.');
}
