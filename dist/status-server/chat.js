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
exports.buildContextUsage = buildContextUsage;
exports.resolveActiveChatModel = resolveActiveChatModel;
exports.buildChatCompletionRequest = buildChatCompletionRequest;
exports.generateChatAssistantMessage = generateChatAssistantMessage;
exports.appendChatMessagesWithUsage = appendChatMessagesWithUsage;
exports.streamChatAssistantMessage = streamChatAssistantMessage;
exports.condenseChatSession = condenseChatSession;
exports.buildPlanRequestPrompt = buildPlanRequestPrompt;
exports.buildPlanMarkdownFromRepoSearch = buildPlanMarkdownFromRepoSearch;
exports.getScorecardTotal = getScorecardTotal;
exports.buildToolContextFromRepoSearchResult = buildToolContextFromRepoSearchResult;
exports.buildRepoSearchMarkdown = buildRepoSearchMarkdown;
exports.loadRepoSearchExecutor = loadRepoSearchExecutor;
const http = __importStar(require("node:http"));
const https = __importStar(require("node:https"));
const crypto = __importStar(require("node:crypto"));
const chat_sessions_js_1 = require("../state/chat-sessions.js");
const http_utils_js_1 = require("./http-utils.js");
const config_store_js_1 = require("./config-store.js");
function buildContextUsage(session) {
    const contextWindowTokens = Math.max(1, Number(session.contextWindowTokens || 150000));
    const estimatedTokenFallbackTokens = Array.isArray(session.messages)
        ? session.messages.reduce((sum, message) => {
            const inputTokens = Number(message.inputTokensEstimate || 0);
            const outputTokens = Number(message.outputTokensEstimate || 0);
            const thinkingTokens = Number(message.thinkingTokens || 0);
            const inputEstimated = message?.inputTokensEstimated === true ? inputTokens : 0;
            const outputEstimated = message?.outputTokensEstimated === true ? outputTokens : 0;
            const thinkingEstimated = message?.thinkingTokensEstimated === true ? thinkingTokens : 0;
            return sum + inputEstimated + outputEstimated + thinkingEstimated;
        }, 0)
        : 0;
    const chatUsedTokens = Array.isArray(session.messages)
        ? session.messages.reduce((sum, message) => (sum
            + Number(message.inputTokensEstimate || 0)
            + Number(message.outputTokensEstimate || 0)
            + Number(message.thinkingTokens || 0)), 0)
        : 0;
    const toolUsedTokens = Array.isArray(session.hiddenToolContexts)
        ? session.hiddenToolContexts.reduce((sum, entry) => sum + (Number(entry?.tokenEstimate) || 0), 0)
        : 0;
    const totalUsedTokens = chatUsedTokens + toolUsedTokens;
    const remainingTokens = Math.max(contextWindowTokens - totalUsedTokens, 0);
    const warnThresholdTokens = Math.max(5000, Math.ceil(contextWindowTokens * 0.1));
    return {
        contextWindowTokens,
        usedTokens: chatUsedTokens,
        chatUsedTokens,
        toolUsedTokens,
        totalUsedTokens,
        remainingTokens,
        warnThresholdTokens,
        shouldCondense: remainingTokens <= warnThresholdTokens,
        estimatedTokenFallbackTokens,
    };
}
function resolveActiveChatModel(config, session) {
    if (typeof session?.model === 'string' && session.model.trim()) {
        return session.model.trim();
    }
    const runtime = config?.Runtime;
    if (typeof runtime?.Model === 'string' && runtime.Model.trim()) {
        return runtime.Model.trim();
    }
    if (typeof config?.Model === 'string' && config.Model.trim()) {
        return config.Model.trim();
    }
    return config_store_js_1.DEFAULT_LLAMA_MODEL;
}
function getChatUsageValue(value) {
    return Number.isFinite(value) && Number(value) >= 0 ? Number(value) : null;
}
function getTextContent(value) {
    if (typeof value === 'string') {
        return value;
    }
    if (!Array.isArray(value)) {
        return '';
    }
    return value
        .map((part) => {
        if (part && typeof part === 'object') {
            const partDict = part;
            if (partDict.type === 'text' || !partDict.type) {
                return String(partDict.text || '');
            }
        }
        return '';
    })
        .join('');
}
function getThinkingTokensFromUsage(usage) {
    if (!usage || typeof usage !== 'object') {
        return null;
    }
    const usageDict = usage;
    const completionDetails = usageDict.completion_tokens_details && typeof usageDict.completion_tokens_details === 'object'
        ? usageDict.completion_tokens_details
        : null;
    const outputDetails = usageDict.output_tokens_details && typeof usageDict.output_tokens_details === 'object'
        ? usageDict.output_tokens_details
        : null;
    const sources = [completionDetails, outputDetails, usageDict];
    for (const source of sources) {
        if (!source || typeof source !== 'object') {
            continue;
        }
        const reasoningTokens = getChatUsageValue(source.reasoning_tokens) ?? 0;
        const thinkingTokens = getChatUsageValue(source.thinking_tokens) ?? 0;
        if (Object.prototype.hasOwnProperty.call(source, 'reasoning_tokens')
            || Object.prototype.hasOwnProperty.call(source, 'thinking_tokens')) {
            return reasoningTokens + thinkingTokens;
        }
    }
    return null;
}
function getPromptCacheTokensFromUsage(usage) {
    if (!usage || typeof usage !== 'object') {
        return null;
    }
    const usageDict = usage;
    const promptDetails = usageDict.prompt_tokens_details && typeof usageDict.prompt_tokens_details === 'object'
        ? usageDict.prompt_tokens_details
        : null;
    const inputDetails = usageDict.input_tokens_details && typeof usageDict.input_tokens_details === 'object'
        ? usageDict.input_tokens_details
        : null;
    const sources = [promptDetails, inputDetails, usageDict];
    for (const source of sources) {
        if (!source || typeof source !== 'object') {
            continue;
        }
        const cachedTokens = getChatUsageValue(source.cached_tokens);
        if (cachedTokens !== null) {
            return cachedTokens;
        }
    }
    return null;
}
function getPromptEvalTokensFromUsage(usage) {
    if (!usage || typeof usage !== 'object') {
        return null;
    }
    const usageDict = usage;
    const promptDetails = usageDict.prompt_tokens_details && typeof usageDict.prompt_tokens_details === 'object'
        ? usageDict.prompt_tokens_details
        : null;
    const inputDetails = usageDict.input_tokens_details && typeof usageDict.input_tokens_details === 'object'
        ? usageDict.input_tokens_details
        : null;
    const sources = [promptDetails, inputDetails, usageDict];
    for (const source of sources) {
        if (!source || typeof source !== 'object') {
            continue;
        }
        const explicitPromptEvalTokens = getChatUsageValue(source.prompt_eval_tokens);
        if (explicitPromptEvalTokens !== null) {
            return explicitPromptEvalTokens;
        }
        const explicitNonCachedTokens = getChatUsageValue(source.non_cached_tokens);
        if (explicitNonCachedTokens !== null) {
            return explicitNonCachedTokens;
        }
        const llamaPromptTokens = getChatUsageValue(source.prompt_n);
        if (llamaPromptTokens !== null) {
            return llamaPromptTokens;
        }
    }
    const promptTokens = getChatUsageValue(usageDict.prompt_tokens);
    const promptCacheTokens = getPromptCacheTokensFromUsage(usage);
    if (promptTokens !== null && promptCacheTokens !== null) {
        return Math.max(promptTokens - promptCacheTokens, 0);
    }
    return null;
}
function getChoiceText(choice) {
    const message = choice?.message;
    const content = message?.content ?? choice?.text ?? '';
    return getTextContent(content).trim();
}
function getChoiceReasoningText(choice) {
    const message = choice?.message;
    const content = message?.reasoning_content ?? '';
    return getTextContent(content).trim();
}
function buildChatCompletionRequest(config, session, userContent, options = {}) {
    const model = resolveActiveChatModel(config, session);
    const baseUrl = (0, config_store_js_1.getLlamaBaseUrl)(config);
    if (!baseUrl) {
        throw new Error('llama.cpp base URL is not configured.');
    }
    const runtimeLlama = (0, config_store_js_1.getCompatRuntimeLlamaCpp)(config);
    const priorMessages = Array.isArray(session.messages) ? session.messages : [];
    const hiddenToolContexts = Array.isArray(session.hiddenToolContexts)
        ? session.hiddenToolContexts
            .map((entry) => (entry && typeof entry.content === 'string' ? entry.content.trim() : ''))
            .filter(Boolean)
        : [];
    const hiddenToolContextText = hiddenToolContexts.join('\n\n');
    const systemContent = hiddenToolContextText
        ? `general, coder friendly assistant\n\nInternal tool-call context from prior session steps. Use this as additional evidence only when relevant.\n\n${hiddenToolContextText}`
        : 'general, coder friendly assistant';
    const messages = [
        { role: 'system', content: systemContent },
        ...priorMessages.map((message) => ({
            role: message.role === 'assistant' ? 'assistant' : 'user',
            content: String(message.content || ''),
        })),
        { role: 'user', content: userContent },
    ];
    const thinkingEnabled = options.thinkingEnabled !== false;
    const body = {
        model,
        messages,
        stream: Boolean(options.stream),
        cache_prompt: true,
        ...(Number.isFinite(runtimeLlama?.Temperature) ? { temperature: Number(runtimeLlama.Temperature) } : {}),
        ...(Number.isFinite(runtimeLlama?.TopP) ? { top_p: Number(runtimeLlama.TopP) } : {}),
        ...(Number.isFinite(runtimeLlama?.MaxTokens) ? { max_tokens: Number(runtimeLlama.MaxTokens) } : {}),
        chat_template_kwargs: {
            enable_thinking: thinkingEnabled,
        },
        extra_body: {
            ...(Number.isFinite(runtimeLlama?.TopK) ? { top_k: Number(runtimeLlama.TopK) } : {}),
            ...(Number.isFinite(runtimeLlama?.MinP) ? { min_p: Number(runtimeLlama.MinP) } : {}),
            ...(Number.isFinite(runtimeLlama?.PresencePenalty) ? { presence_penalty: Number(runtimeLlama.PresencePenalty) } : {}),
            ...(Number.isFinite(runtimeLlama?.RepetitionPenalty) ? { repeat_penalty: Number(runtimeLlama.RepetitionPenalty) } : {}),
            ...(thinkingEnabled ? {} : { reasoning_budget: 0 }),
        },
    };
    return {
        url: `${baseUrl.replace(/\/$/u, '')}/v1/chat/completions`,
        model,
        body,
    };
}
async function generateChatAssistantMessage(config, session, userContent) {
    const request = buildChatCompletionRequest(config, session, userContent, {
        thinkingEnabled: session.thinkingEnabled !== false,
        stream: false,
    });
    const response = await (0, http_utils_js_1.requestJson)(request.url, {
        method: 'POST',
        timeoutMs: 600000,
        body: JSON.stringify(request.body),
    });
    if (response.statusCode >= 400) {
        const detail = String(response.rawText || '').trim();
        throw new Error(`llama.cpp chat failed with HTTP ${response.statusCode}${detail ? `: ${detail}` : '.'}`);
    }
    const responseBody = response.body;
    const choice = Array.isArray(responseBody?.choices) ? responseBody.choices[0] : null;
    const assistantContent = getChoiceText(choice);
    const thinkingContent = getChoiceReasoningText(choice);
    if (!assistantContent) {
        throw new Error('llama.cpp chat returned an empty assistant message.');
    }
    const usage = responseBody?.usage && typeof responseBody.usage === 'object' ? responseBody.usage : {};
    return {
        assistantContent,
        thinkingContent,
        usage: {
            promptTokens: getChatUsageValue(usage.prompt_tokens),
            completionTokens: getChatUsageValue(usage.completion_tokens),
            thinkingTokens: getThinkingTokensFromUsage(usage),
            promptCacheTokens: getPromptCacheTokensFromUsage(usage),
            promptEvalTokens: getPromptEvalTokensFromUsage(usage),
        },
    };
}
function appendChatMessagesWithUsage(runtimeRoot, session, content, assistantContent, usage = {}, thinkingContent = '', options = {}) {
    const now = new Date().toISOString();
    const messages = Array.isArray(session.messages) ? session.messages.slice() : [];
    const promptTokens = getChatUsageValue(usage.promptTokens);
    const completionTokens = getChatUsageValue(usage.completionTokens);
    const usageThinkingTokens = getChatUsageValue(usage.thinkingTokens);
    const userTokens = promptTokens ?? (0, chat_sessions_js_1.estimateTokenCount)(content);
    const outputTokens = completionTokens ?? (0, chat_sessions_js_1.estimateTokenCount)(assistantContent);
    const thinkingTokens = usageThinkingTokens ?? 0;
    const toolContextContents = Array.isArray(options.toolContextContents)
        ? options.toolContextContents
            .map((value) => String(value || '').trim())
            .filter(Boolean)
        : [];
    const hiddenToolContexts = Array.isArray(session.hiddenToolContexts) ? session.hiddenToolContexts.slice() : [];
    messages.push({
        id: crypto.randomUUID(),
        role: 'user',
        content,
        inputTokensEstimate: userTokens,
        outputTokensEstimate: 0,
        thinkingTokens: 0,
        inputTokensEstimated: promptTokens === null,
        outputTokensEstimated: false,
        thinkingTokensEstimated: false,
        createdAtUtc: now,
        sourceRunId: null,
    });
    const assistantMessageId = crypto.randomUUID();
    const associatedToolTokens = toolContextContents.reduce((sum, value) => sum + (0, chat_sessions_js_1.estimateTokenCount)(value), 0);
    messages.push({
        id: assistantMessageId,
        role: 'assistant',
        content: assistantContent,
        inputTokensEstimate: 0,
        outputTokensEstimate: outputTokens,
        thinkingTokens,
        inputTokensEstimated: false,
        outputTokensEstimated: completionTokens === null,
        thinkingTokensEstimated: usageThinkingTokens === null,
        promptCacheTokens: getChatUsageValue(usage.promptCacheTokens),
        promptEvalTokens: getChatUsageValue(usage.promptEvalTokens),
        associatedToolTokens,
        thinkingContent: String(thinkingContent || ''),
        createdAtUtc: now,
        sourceRunId: null,
    });
    for (const value of toolContextContents) {
        hiddenToolContexts.push({
            id: crypto.randomUUID(),
            content: value,
            tokenEstimate: (0, chat_sessions_js_1.estimateTokenCount)(value),
            sourceMessageId: assistantMessageId,
            createdAtUtc: now,
        });
    }
    const updated = {
        ...session,
        updatedAtUtc: now,
        messages,
        hiddenToolContexts,
    };
    (0, chat_sessions_js_1.saveChatSession)(runtimeRoot, updated);
    return updated;
}
async function streamChatAssistantMessage(config, session, userContent, onProgress) {
    const requestConfig = buildChatCompletionRequest(config, session, userContent, {
        thinkingEnabled: session.thinkingEnabled !== false,
        stream: true,
    });
    const target = new URL(requestConfig.url);
    const transport = target.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
        const request = transport.request({
            protocol: target.protocol,
            hostname: target.hostname,
            port: target.port || (target.protocol === 'https:' ? 443 : 80),
            path: `${target.pathname}${target.search}`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(JSON.stringify(requestConfig.body), 'utf8'),
            },
        }, (response) => {
            if ((response.statusCode || 0) >= 400) {
                let body = '';
                response.setEncoding('utf8');
                response.on('data', (chunk) => {
                    body += chunk;
                });
                response.on('end', () => {
                    reject(new Error(`llama.cpp chat stream failed with HTTP ${response.statusCode || 0}${body.trim() ? `: ${body.trim()}` : '.'}`));
                });
                return;
            }
            let rawBuffer = '';
            let assistantContent = '';
            let thinkingContent = '';
            let finalUsage = { promptTokens: null, completionTokens: null, thinkingTokens: null, promptCacheTokens: null, promptEvalTokens: null };
            response.setEncoding('utf8');
            response.on('data', (chunk) => {
                rawBuffer += chunk;
                let boundary = rawBuffer.indexOf('\n\n');
                while (boundary >= 0) {
                    const packet = rawBuffer.slice(0, boundary);
                    rawBuffer = rawBuffer.slice(boundary + 2);
                    boundary = rawBuffer.indexOf('\n\n');
                    const lines = packet
                        .split(/\r?\n/gu)
                        .map((line) => line.trim())
                        .filter(Boolean);
                    const dataLine = lines.find((line) => line.startsWith('data:'));
                    if (!dataLine) {
                        continue;
                    }
                    const dataValue = dataLine.slice(5).trim();
                    if (dataValue === '[DONE]') {
                        continue;
                    }
                    try {
                        const parsed = JSON.parse(dataValue);
                        const choice = Array.isArray(parsed?.choices) ? parsed.choices[0] : null;
                        const delta = choice?.delta && typeof choice.delta === 'object' ? choice.delta : {};
                        const deltaThinking = getTextContent(delta.reasoning_content);
                        const deltaAnswer = getTextContent(delta.content);
                        if (deltaThinking) {
                            thinkingContent += deltaThinking;
                        }
                        if (deltaAnswer) {
                            assistantContent += deltaAnswer;
                        }
                        if (parsed?.usage && typeof parsed.usage === 'object') {
                            const usage = parsed.usage;
                            finalUsage = {
                                promptTokens: getChatUsageValue(usage.prompt_tokens),
                                completionTokens: getChatUsageValue(usage.completion_tokens),
                                thinkingTokens: getThinkingTokensFromUsage(usage),
                                promptCacheTokens: getPromptCacheTokensFromUsage(usage),
                                promptEvalTokens: getPromptEvalTokensFromUsage(usage),
                            };
                        }
                        if (typeof onProgress === 'function') {
                            onProgress({
                                assistantContent,
                                thinkingContent,
                            });
                        }
                    }
                    catch {
                        // Ignore malformed stream chunks.
                    }
                }
            });
            response.on('end', () => {
                if (!assistantContent.trim()) {
                    reject(new Error('llama.cpp chat stream returned an empty assistant message.'));
                    return;
                }
                resolve({
                    assistantContent: assistantContent.trim(),
                    thinkingContent: thinkingContent.trim(),
                    usage: finalUsage,
                });
            });
        });
        request.setTimeout(600000, () => {
            request.destroy(new Error('llama.cpp chat stream timed out.'));
        });
        request.on('error', reject);
        request.write(JSON.stringify(requestConfig.body));
        request.end();
    });
}
function condenseChatSession(runtimeRoot, session) {
    const now = new Date().toISOString();
    const messages = Array.isArray(session.messages) ? session.messages.slice() : [];
    const keptCount = Math.min(messages.length, 2);
    const startIndex = Math.max(messages.length - keptCount, 0);
    const sourceMessages = startIndex > 0 ? messages.slice(0, startIndex) : messages;
    const condensedText = sourceMessages
        .map((message) => `${message.role}: ${String(message.content || '')}`)
        .join('\n');
    const condensedTail = condensedText.length > 2400 ? condensedText.slice(condensedText.length - 2400) : condensedText;
    const nextMessages = messages.map((message, index) => ({
        ...message,
        compressedIntoSummary: index < startIndex,
    }));
    const updated = {
        ...session,
        updatedAtUtc: now,
        condensedSummary: condensedTail || session.condensedSummary || '',
        messages: nextMessages,
    };
    (0, chat_sessions_js_1.saveChatSession)(runtimeRoot, updated);
    return updated;
}
function buildPlanRequestPrompt(userPrompt) {
    const task = String(userPrompt || '').trim();
    return [
        'You are creating an implementation plan from repository evidence.',
        'Search thoroughly before finishing.',
        'Required output format (Markdown):',
        '1. Summary of Request and Approach',
        '2. Goal',
        '3. Current State (with explicit file paths)',
        '4. Implementation Plan (numbered steps covering what, where, how, and why)',
        '5. Code Evidence (each bullet must include file path + line numbers + a short code snippet)',
        '6. Critical Review (risks, flaws, better alternatives, edge cases, missing tests)',
        '7. Validation Plan (tests + checks)',
        '8. Open Questions (if any)',
        'Constraints:',
        '- Start with a short "Summary of Request and Approach" describing how you will tackle the request.',
        '- Review for any misalignment between the request and existing repository behavior/architecture; call it out explicitly.',
        '- If the request appears faulty, contradictory, or nonsensical, say so clearly and explain why.',
        '- Add clear open questions at the bottom when clarification is needed to refine the plan.',
        '- The plan should be comprehensive and usable as an implementation blueprint.',
        '- Be critical; call out any concerns clearly.',
        '- Use concrete line references like path/to/file.ts:123.',
        '- Include short code snippets for the referenced lines and explain the reasoning for proposed changes.',
        '- Prefer precise, executable steps over broad advice.',
        '',
        `Task: ${task}`,
    ].join('\n');
}
function truncatePlanEvidence(value, maxLength = 700) {
    const text = String(value || '').trim();
    if (!text) {
        return '';
    }
    if (text.length <= maxLength) {
        return text;
    }
    return `${text.slice(0, maxLength)}\n... (truncated)`;
}
function buildPlanMarkdownFromRepoSearch(userPrompt, repoRoot, result) {
    const scorecard = result && typeof result.scorecard === 'object' ? result.scorecard : {};
    const tasks = Array.isArray(scorecard.tasks) ? scorecard.tasks : [];
    const primaryTask = tasks[0] && typeof tasks[0] === 'object' ? tasks[0] : null;
    const modelOutput = typeof primaryTask?.finalOutput === 'string' && primaryTask.finalOutput.trim()
        ? primaryTask.finalOutput.trim()
        : 'No final planner output was produced.';
    const commandEvidence = [];
    for (let taskIndex = tasks.length - 1; taskIndex >= 0; taskIndex -= 1) {
        const task = tasks[taskIndex];
        if (!task || typeof task !== 'object' || !Array.isArray(task.commands)) {
            continue;
        }
        const commands = task.commands;
        for (let commandIndex = commands.length - 1; commandIndex >= 0; commandIndex -= 1) {
            const command = commands[commandIndex];
            if (!command || typeof command !== 'object') {
                continue;
            }
            const commandText = typeof command.command === 'string' ? command.command.trim() : '';
            const outputText = truncatePlanEvidence(command.output);
            if (!commandText || !outputText) {
                continue;
            }
            commandEvidence.push({ command: commandText, output: outputText });
            if (commandEvidence.length >= 6) {
                break;
            }
        }
        if (commandEvidence.length >= 6) {
            break;
        }
    }
    const lines = [
        '# Implementation Plan',
        '',
        '## Request',
        userPrompt,
        '',
        '## Target Repo Root',
        `\`${repoRoot}\``,
        '',
        '## Planner Output',
        modelOutput,
        '',
        '## Code Evidence',
    ];
    if (commandEvidence.length === 0) {
        lines.push('- No command evidence was captured.');
    }
    else {
        for (const entry of commandEvidence) {
            lines.push(`- Command: \`${entry.command}\``);
            lines.push('```text');
            lines.push(entry.output);
            lines.push('```');
        }
    }
    lines.push('', '## Critical Review');
    const missingSignals = Array.isArray(primaryTask?.missingSignals) ? primaryTask.missingSignals : [];
    if (missingSignals.length > 0) {
        lines.push(`- Missing expected evidence signals: ${missingSignals.join(', ')}`);
    }
    else {
        lines.push('- Verify that proposed changes preserve existing behavior and test coverage.');
    }
    lines.push('- Check for hidden coupling between chat flow state, session persistence, and model-request locking.');
    lines.push('- Validate repo-root input carefully to avoid running searches outside intended workspace.');
    lines.push('', '## Artifacts');
    lines.push(`- Transcript: \`${String(result?.transcriptPath || '')}\``);
    lines.push(`- Artifact: \`${String(result?.artifactPath || '')}\``);
    return lines.join('\n');
}
function getScorecardTotal(scorecard, key) {
    if (!scorecard || typeof scorecard !== 'object') {
        return null;
    }
    const totals = scorecard.totals;
    if (!totals || typeof totals !== 'object') {
        return null;
    }
    const value = totals[key];
    return Number.isFinite(value) && Number(value) >= 0 ? Number(value) : null;
}
function truncateToolContextOutput(value, maxLength = 1400) {
    const text = String(value || '').trim();
    if (!text) {
        return '';
    }
    if (text.length <= maxLength) {
        return text;
    }
    return `${text.slice(0, maxLength)}\n... (truncated)`;
}
function buildToolContextFromRepoSearchResult(result) {
    const scorecard = result && typeof result.scorecard === 'object' ? result.scorecard : {};
    const tasks = Array.isArray(scorecard.tasks) ? scorecard.tasks : [];
    const contexts = [];
    for (const task of tasks) {
        if (!task || typeof task !== 'object' || !Array.isArray(task.commands)) {
            continue;
        }
        for (const command of task.commands) {
            if (!command || typeof command !== 'object') {
                continue;
            }
            const commandText = typeof command.command === 'string' ? command.command.trim() : '';
            if (!commandText) {
                continue;
            }
            const outputText = truncateToolContextOutput(command.output);
            const exitCode = Number.isFinite(command.exitCode) ? Number(command.exitCode) : null;
            contexts.push([
                `Command: ${commandText}`,
                `Exit Code: ${exitCode === null ? 'n/a' : String(exitCode)}`,
                'Result:',
                outputText || '(empty output)',
            ].join('\n'));
        }
    }
    return contexts;
}
function buildRepoSearchMarkdown(userPrompt, repoRoot, result) {
    const scorecard = result && typeof result.scorecard === 'object' ? result.scorecard : {};
    const tasks = Array.isArray(scorecard.tasks) ? scorecard.tasks : [];
    const primaryTask = tasks[0] && typeof tasks[0] === 'object' ? tasks[0] : null;
    const modelOutput = typeof primaryTask?.finalOutput === 'string' && primaryTask.finalOutput.trim()
        ? primaryTask.finalOutput.trim()
        : 'No repo-search output was produced.';
    const commandEvidence = [];
    for (const task of tasks) {
        if (!task || typeof task !== 'object' || !Array.isArray(task.commands)) {
            continue;
        }
        for (const command of task.commands) {
            if (!command || typeof command !== 'object') {
                continue;
            }
            const commandText = typeof command.command === 'string' ? command.command.trim() : '';
            const outputText = truncatePlanEvidence(command.output);
            if (!commandText || !outputText) {
                continue;
            }
            commandEvidence.push({ command: commandText, output: outputText });
            if (commandEvidence.length >= 10) {
                break;
            }
        }
        if (commandEvidence.length >= 10) {
            break;
        }
    }
    const lines = [
        '# Repo Search Results',
        '',
        '## Query',
        userPrompt,
        '',
        '## Repo Root',
        `\`${repoRoot}\``,
        '',
        '## Output',
        modelOutput,
        '',
        '## Commands Executed',
    ];
    if (commandEvidence.length === 0) {
        lines.push('- No commands were executed.');
    }
    else {
        for (const entry of commandEvidence) {
            lines.push(`- \`${entry.command}\``);
            lines.push('```text');
            lines.push(entry.output);
            lines.push('```');
        }
    }
    lines.push('', '## Artifacts');
    lines.push(`- Transcript: \`${String(result?.transcriptPath || '')}\``);
    lines.push(`- Artifact: \`${String(result?.artifactPath || '')}\``);
    return lines.join('\n');
}
function loadRepoSearchExecutor() {
    const modulePath = require.resolve('../repo-search/index.js');
    delete require.cache[modulePath];
    const loadedModule = require(modulePath);
    if (!loadedModule || typeof loadedModule.executeRepoSearchRequest !== 'function') {
        throw new Error('repo-search module does not export executeRepoSearchRequest.');
    }
    return loadedModule.executeRepoSearchRequest;
}
