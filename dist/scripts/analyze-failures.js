"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const REQUESTS_DIR = '.siftkit/logs/requests/';
const LOGS_DIR = '.siftkit/logs/';
function loadDebug(plannerDebugPath) {
    const basename = node_path_1.default.basename(plannerDebugPath);
    try {
        return JSON.parse(node_fs_1.default.readFileSync(LOGS_DIR + basename, 'utf8'));
    }
    catch {
        return null;
    }
}
function truncate(s, max = 600) {
    if (!s)
        return '(empty)';
    if (s.length <= max)
        return s;
    return s.substring(0, max) + '... [truncated, total ' + s.length + ' chars]';
}
function separator(title) {
    console.log('\n' + '='.repeat(80));
    console.log('  ' + title);
    console.log('='.repeat(80));
}
const files = node_fs_1.default.readdirSync(REQUESTS_DIR);
const allRequests = files.map(f => {
    const data = JSON.parse(node_fs_1.default.readFileSync(REQUESTS_DIR + f, 'utf8'));
    data._filename = f;
    return data;
});
const failures = allRequests.filter(r => r.classification === 'command_failure' && r.plannerDebugPath);
const successes = allRequests.filter(r => r.classification !== 'command_failure' && r.plannerDebugPath);
console.log('Total requests:', allRequests.length);
console.log('Failures with planner debug:', failures.length);
console.log('Successes with planner debug:', successes.length);
const categories = {
    planner_invalid_response_limit: [],
    json_filter: [],
    invalid_regex: [],
    planner_tool_call_limit: [],
    planner_headroom_exceeded: [],
    empty_response: [],
    other: [],
    no_events: [],
};
for (const req of failures) {
    const debug = loadDebug(req.plannerDebugPath);
    if (!debug)
        continue;
    const reason = debug.final?.reason || '';
    const entry = { req, debug, reason };
    if (!debug.events || debug.events.length === 0) {
        categories.no_events.push(entry);
    }
    else if (reason === 'planner_invalid_response_limit') {
        categories.planner_invalid_response_limit.push(entry);
    }
    else if (reason.includes('json_filter')) {
        categories.json_filter.push(entry);
    }
    else if (reason.includes('Invalid regular expression') || reason.includes('Invalid regex')) {
        categories.invalid_regex.push(entry);
    }
    else if (reason === 'planner_tool_call_limit') {
        categories.planner_tool_call_limit.push(entry);
    }
    else if (reason === 'planner_headroom_exceeded') {
        categories.planner_headroom_exceeded.push(entry);
    }
    else if (reason.includes('did not return a response body') || reason.includes('content":"')) {
        categories.empty_response.push(entry);
    }
    else {
        categories.other.push(entry);
    }
}
console.log('\nCategory counts:');
for (const [k, v] of Object.entries(categories)) {
    console.log('  ' + k + ': ' + v.length);
}
// 1. planner_invalid_response_limit
separator('CATEGORY 1: planner_invalid_response_limit (' + categories.planner_invalid_response_limit.length + ' total)');
console.log('These are cases where the model output could not be parsed as a valid planner action.\n');
const invalidResponseSamples = categories.planner_invalid_response_limit.slice(0, 5);
for (let i = 0; i < invalidResponseSamples.length; i++) {
    const { req, debug } = invalidResponseSamples[i];
    console.log(`--- Example ${i + 1} (${req.requestId}) ---`);
    console.log('Question:', truncate(req.question, 120));
    console.log('Input text length:', req.inputText?.length || 0);
    console.log('Events count:', debug.events.length);
    for (const event of debug.events) {
        if (event.kind === 'planner_model_response') {
            console.log('\n  [MODEL RESPONSE] (thinking:', event.thinkingProcess ? 'yes' : 'no', ')');
            console.log('  Raw text:', truncate(event.responseText, 500));
        }
        if (event.kind === 'planner_invalid_response') {
            console.log('  [PARSE ERROR]:', event.error);
        }
        if (event.kind === 'planner_tool_call') {
            console.log('  [TOOL CALL]:', event.toolName, '->', truncate(JSON.stringify(event.toolArgs || event.args), 200));
        }
        if (event.kind === 'planner_tool_result') {
            console.log('  [TOOL RESULT]:', truncate(event.result || event.output || JSON.stringify(event), 150));
        }
    }
    console.log();
}
// 2. json_filter errors
separator('CATEGORY 2: json_filter errors (' + categories.json_filter.length + ' total)');
console.log('These are cases where the model passed wrong arguments to json_filter tool.\n');
const jsonFilterSamples = categories.json_filter.slice(0, 5);
for (let i = 0; i < jsonFilterSamples.length; i++) {
    const { req, debug } = jsonFilterSamples[i];
    console.log(`--- Example ${i + 1} (${req.requestId}) ---`);
    console.log('Question:', truncate(req.question, 120));
    console.log('Failure reason:', debug.final?.reason);
    for (const event of (debug.events || [])) {
        if (event.kind === 'planner_tool_call' && (event.toolName === 'json_filter' || JSON.stringify(event).includes('json_filter'))) {
            console.log('\n  [JSON_FILTER CALL]:', truncate(JSON.stringify(event.toolArgs || event.args || event), 400));
        }
        if (event.kind === 'planner_tool_error' || (event.kind === 'planner_tool_result' && (event.error || (event.result || '').includes('error')))) {
            console.log('  [TOOL ERROR]:', truncate(event.error || event.result || JSON.stringify(event), 300));
        }
        if (event.kind === 'planner_model_response') {
            console.log('\n  [MODEL RESPONSE]:', truncate(event.responseText, 400));
        }
    }
    console.log();
}
// 3. Invalid regex errors
separator('CATEGORY 3: Invalid regex errors (' + categories.invalid_regex.length + ' total)');
const regexSamples = categories.invalid_regex.slice(0, 5);
for (let i = 0; i < regexSamples.length; i++) {
    const { req, debug } = regexSamples[i];
    console.log(`--- Example ${i + 1} (${req.requestId}) ---`);
    console.log('Question:', truncate(req.question, 120));
    console.log('Failure reason:', debug.final?.reason);
    for (const event of (debug.events || [])) {
        if (event.kind === 'planner_model_response') {
            console.log('\n  [MODEL RESPONSE]:', truncate(event.responseText, 400));
        }
        if (event.kind === 'planner_tool_call') {
            console.log('  [TOOL CALL]:', event.toolName, '->', truncate(JSON.stringify(event.toolArgs || event.args || event), 300));
        }
        if (event.kind === 'planner_tool_error') {
            console.log('  [TOOL ERROR]:', truncate(event.error || JSON.stringify(event), 200));
        }
    }
    console.log();
}
// 4. planner_tool_call_limit
separator('CATEGORY 4: planner_tool_call_limit (' + categories.planner_tool_call_limit.length + ' total)');
console.log('These hit the 30 tool call limit.\n');
const toolCallLimitSamples = categories.planner_tool_call_limit.slice(0, 5);
for (let i = 0; i < toolCallLimitSamples.length; i++) {
    const { req, debug } = toolCallLimitSamples[i];
    console.log(`--- Example ${i + 1} (${req.requestId}) ---`);
    console.log('Question:', truncate(req.question, 120));
    const toolCalls = (debug.events || []).filter(e => e.kind === 'planner_tool_call');
    const invalidResponses = (debug.events || []).filter(e => e.kind === 'planner_invalid_response');
    console.log('Total tool calls:', toolCalls.length);
    console.log('Invalid responses:', invalidResponses.length);
    console.log('Tool call sequence:');
    for (const tc of toolCalls) {
        console.log('  ->', tc.toolName, ':', truncate(JSON.stringify(tc.toolArgs || tc.args), 150));
    }
    for (const ir of invalidResponses) {
        console.log('  [INVALID]:', ir.error);
    }
    console.log();
}
// 5. planner_headroom_exceeded
separator('CATEGORY 5: planner_headroom_exceeded (' + categories.planner_headroom_exceeded.length + ' total)');
const headroomSamples = categories.planner_headroom_exceeded.slice(0, 5);
for (let i = 0; i < headroomSamples.length; i++) {
    const { req, debug } = headroomSamples[i];
    console.log(`--- Example ${i + 1} (${req.requestId}) ---`);
    console.log('Question:', truncate(req.question, 120));
    console.log('Input text length:', req.inputText?.length || 0);
    const prompts = (debug.events || []).filter(e => e.kind === 'planner_prompt');
    const toolCalls = (debug.events || []).filter(e => e.kind === 'planner_tool_call');
    console.log('Prompt events:', prompts.length);
    console.log('Tool calls:', toolCalls.length);
    for (const p of prompts) {
        console.log('  [PROMPT] tokenCount:', p.promptTokenCount, 'toolCallCount:', p.toolCallCount, 'budget:', p.plannerBudget);
    }
    const responses = (debug.events || []).filter(e => e.kind === 'planner_model_response');
    for (const r of responses.slice(0, 2)) {
        console.log('  [MODEL RESPONSE]:', truncate(r.responseText, 300));
    }
    console.log();
}
// 6. Empty responses / HTTP errors
separator('CATEGORY 6: Empty responses / HTTP errors (' + categories.empty_response.length + ' total)');
const emptySamples = categories.empty_response.slice(0, 3);
for (let i = 0; i < emptySamples.length; i++) {
    const { req, debug } = emptySamples[i];
    console.log(`--- Example ${i + 1} (${req.requestId}) ---`);
    console.log('Question:', truncate(req.question, 120));
    console.log('Failure reason:', truncate(debug.final?.reason, 300));
    console.log();
}
// 7. SUCCESSFUL requests
separator('SUCCESSFUL REQUESTS - Good tool call flows (' + successes.length + ' total successful with debug)');
const successWithEvents = [];
for (const req of successes) {
    if (successWithEvents.length >= 10)
        break;
    const debug = loadDebug(req.plannerDebugPath);
    if (debug && debug.events && debug.events.length > 0) {
        const toolCalls = debug.events.filter(e => e.kind === 'planner_tool_call');
        if (toolCalls.length > 0) {
            successWithEvents.push({ req, debug });
        }
    }
}
console.log('Found', successWithEvents.length, 'successful requests with tool call events\n');
const successSamples = successWithEvents.slice(0, 5);
for (let i = 0; i < successSamples.length; i++) {
    const { req, debug } = successSamples[i];
    console.log(`--- Successful Example ${i + 1} (${req.requestId}) ---`);
    console.log('Question:', truncate(req.question, 120));
    console.log('Classification:', req.classification);
    console.log('Events count:', debug.events.length);
    for (const event of debug.events) {
        if (event.kind === 'planner_prompt') {
            console.log('  [PROMPT] tokens:', event.promptTokenCount, 'toolCalls:', event.toolCallCount, 'budget:', event.plannerBudget);
        }
        if (event.kind === 'planner_model_response') {
            console.log('  [MODEL RESPONSE]:', truncate(event.responseText, 400));
        }
        if (event.kind === 'planner_tool_call') {
            console.log('  [TOOL CALL]:', event.toolName, '->', truncate(JSON.stringify(event.toolArgs || event.args), 200));
        }
        if (event.kind === 'planner_tool_result') {
            console.log('  [TOOL RESULT]:', truncate(event.result || event.output || JSON.stringify(event), 150));
        }
        if (event.kind === 'planner_invalid_response') {
            console.log('  [INVALID RESPONSE]:', event.error);
        }
        if (event.kind === 'planner_final_output') {
            console.log('  [FINAL OUTPUT]:', truncate(event.output || JSON.stringify(event), 200));
        }
    }
    console.log('  [FINAL STATUS]:', debug.final?.status, 'reason:', debug.final?.reason || 'none');
    console.log();
}
// 8. ANALYSIS: What patterns cause invalid responses?
separator('ANALYSIS: Patterns in invalid model responses');
const invalidTexts = [];
for (const { debug } of categories.planner_invalid_response_limit) {
    for (const event of (debug.events || [])) {
        if (event.kind === 'planner_model_response') {
            invalidTexts.push(event.responseText ?? '');
        }
    }
}
console.log('Total invalid response texts:', invalidTexts.length);
const patterns = {
    starts_with_json_brace: 0,
    starts_with_json_bracket: 0,
    starts_with_think: 0,
    contains_classification: 0,
    contains_tool_call: 0,
    contains_unsupported: 0,
    contains_summary: 0,
    empty_or_whitespace: 0,
    contains_markdown: 0,
    pure_text_prose: 0,
};
for (const text of invalidTexts) {
    const trimmed = (text || '').trim();
    if (!trimmed) {
        patterns.empty_or_whitespace++;
        continue;
    }
    if (trimmed.startsWith('{'))
        patterns.starts_with_json_brace++;
    if (trimmed.startsWith('['))
        patterns.starts_with_json_bracket++;
    if (trimmed.includes('<think>') || trimmed.includes('</think>'))
        patterns.starts_with_think++;
    if (trimmed.includes('"classification"'))
        patterns.contains_classification++;
    if (trimmed.includes('tool_call') || trimmed.includes('tool_name') || trimmed.includes('json_filter') || trimmed.includes('regex_search'))
        patterns.contains_tool_call++;
    if (trimmed.includes('unsupported'))
        patterns.contains_unsupported++;
    if (trimmed.includes('summary') || trimmed.includes('Summary'))
        patterns.contains_summary++;
    if (trimmed.includes('```') || trimmed.includes('##'))
        patterns.contains_markdown++;
}
console.log('\nResponse text patterns:');
for (const [k, v] of Object.entries(patterns)) {
    console.log('  ' + k + ': ' + v);
}
const parseErrors = new Map();
for (const { debug } of categories.planner_invalid_response_limit) {
    for (const event of (debug.events || [])) {
        if (event.kind === 'planner_invalid_response') {
            const err = event.error || 'unknown';
            parseErrors.set(err, (parseErrors.get(err) || 0) + 1);
        }
    }
}
console.log('\nParse error types:');
for (const [k, v] of [...parseErrors.entries()].sort((a, b) => b[1] - a[1])) {
    console.log('  ' + v + 'x: ' + truncate(k, 200));
}
// 9. Detailed look at what the parser expects vs what it gets
separator('DETAILED: First 3 unique response patterns that fail parsing');
const seenPatterns = new Set();
let detailCount = 0;
for (const { debug } of categories.planner_invalid_response_limit) {
    if (detailCount >= 5)
        break;
    for (let j = 0; j < (debug.events || []).length; j++) {
        if (detailCount >= 5)
            break;
        const event = debug.events[j];
        if (event.kind === 'planner_model_response') {
            const text = (event.responseText || '').trim();
            const fp = text.substring(0, 50);
            if (!seenPatterns.has(fp)) {
                seenPatterns.add(fp);
                detailCount++;
                console.log(`\n--- Pattern ${detailCount} ---`);
                console.log('Full response text (' + text.length + ' chars):');
                console.log(truncate(text, 800));
                if (j + 1 < debug.events.length && debug.events[j + 1].kind === 'planner_invalid_response') {
                    console.log('Parse error:', debug.events[j + 1].error);
                }
            }
        }
    }
}
separator('CATEGORY 7: no_events / NO_REASON failures (' + categories.no_events.length + ' total)');
console.log('These failures have no event log - the planner failed before generating events.\n');
const noEventSamples = categories.no_events.slice(0, 5);
for (let i = 0; i < noEventSamples.length; i++) {
    const { req, debug } = noEventSamples[i];
    console.log(`--- Example ${i + 1} (${req.requestId}) ---`);
    console.log('Question:', truncate(req.question, 150));
    console.log('Final output:', truncate(debug.final?.finalOutput, 300));
    console.log('Provider error:', truncate(debug.final?.providerError || 'none', 200));
    console.log();
}
