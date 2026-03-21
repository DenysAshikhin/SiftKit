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
exports.listLlamaCppModels = listLlamaCppModels;
exports.getLlamaCppProviderStatus = getLlamaCppProviderStatus;
exports.generateLlamaCppResponse = generateLlamaCppResponse;
const http = __importStar(require("node:http"));
const https = __importStar(require("node:https"));
const config_js_1 = require("../config.js");
function getUsageValue(value) {
    return Number.isFinite(value) && Number(value) >= 0 ? Number(value) : null;
}
function getThinkingTokenCount(usage) {
    if (!usage) {
        return null;
    }
    const detailCandidates = [
        usage.completion_tokens_details,
        usage.output_tokens_details,
    ];
    for (const details of detailCandidates) {
        if (!details) {
            continue;
        }
        const reasoningTokens = getUsageValue(details.reasoning_tokens) ?? 0;
        const thinkingTokens = getUsageValue(details.thinking_tokens) ?? 0;
        if (Object.prototype.hasOwnProperty.call(details, 'reasoning_tokens')
            || Object.prototype.hasOwnProperty.call(details, 'thinking_tokens')) {
            return reasoningTokens + thinkingTokens;
        }
    }
    const topLevelReasoningTokens = getUsageValue(usage.reasoning_tokens) ?? 0;
    const topLevelThinkingTokens = getUsageValue(usage.thinking_tokens) ?? 0;
    if (Object.prototype.hasOwnProperty.call(usage, 'reasoning_tokens')
        || Object.prototype.hasOwnProperty.call(usage, 'thinking_tokens')) {
        return topLevelReasoningTokens + topLevelThinkingTokens;
    }
    return null;
}
function subtractThinkingTokens(value, thinkingTokens) {
    if (value === null) {
        return null;
    }
    return Math.max(value - (thinkingTokens ?? 0), 0);
}
function requestJson(options) {
    return new Promise((resolve, reject) => {
        const target = new URL(options.url);
        const transport = target.protocol === 'https:' ? https : http;
        const request = transport.request({
            protocol: target.protocol,
            hostname: target.hostname,
            port: target.port || (target.protocol === 'https:' ? 443 : 80),
            path: `${target.pathname}${target.search}`,
            method: options.method,
            headers: options.body ? {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(options.body, 'utf8'),
            } : undefined,
        }, (response) => {
            let responseText = '';
            response.setEncoding('utf8');
            response.on('data', (chunk) => {
                responseText += chunk;
            });
            response.on('end', () => {
                if (!responseText.trim()) {
                    resolve({ statusCode: response.statusCode || 0, body: {}, rawText: '' });
                    return;
                }
                try {
                    resolve({
                        statusCode: response.statusCode || 0,
                        body: JSON.parse(responseText),
                        rawText: responseText,
                    });
                }
                catch (error) {
                    reject(error);
                }
            });
        });
        request.setTimeout(options.timeoutMs, () => {
            request.destroy(new Error(`Request timed out after ${options.timeoutMs} ms.`));
        });
        request.on('error', reject);
        if (options.body) {
            request.write(options.body);
        }
        request.end();
    });
}
function getTextContent(content) {
    if (typeof content === 'string') {
        return content;
    }
    if (!Array.isArray(content)) {
        return '';
    }
    return content
        .map((part) => (part?.type === 'text' || !part?.type) ? String(part?.text || '') : '')
        .join('');
}
async function countLlamaCppTokens(config, content) {
    if (!content.trim()) {
        return 0;
    }
    try {
        const baseUrl = (0, config_js_1.getConfiguredLlamaBaseUrl)(config);
        const response = await requestJson({
            url: `${baseUrl.replace(/\/$/u, '')}/tokenize`,
            method: 'POST',
            timeoutMs: 10_000,
            body: JSON.stringify({ content }),
        });
        if (response.statusCode >= 400 || !Array.isArray(response.body.tokens)) {
            return null;
        }
        return response.body.tokens.length;
    }
    catch {
        return null;
    }
}
async function listLlamaCppModels(config) {
    const baseUrl = (0, config_js_1.getConfiguredLlamaBaseUrl)(config);
    const response = await requestJson({
        url: `${baseUrl.replace(/\/$/u, '')}/v1/models`,
        method: 'GET',
        timeoutMs: 5000,
    });
    if (response.statusCode >= 400) {
        const detail = response.rawText.trim();
        throw new Error(`llama.cpp model list failed with HTTP ${response.statusCode}${detail ? `: ${detail}` : '.'}`);
    }
    return (response.body.data || [])
        .map((entry) => entry.id)
        .filter((value) => Boolean(value && value.trim()));
}
async function getLlamaCppProviderStatus(config) {
    const status = {
        Available: true,
        Reachable: false,
        BaseUrl: null,
        Error: null,
    };
    try {
        status.BaseUrl = (0, config_js_1.getConfiguredLlamaBaseUrl)(config);
        await listLlamaCppModels(config);
        status.Reachable = true;
    }
    catch (error) {
        status.Error = error instanceof Error ? error.message : String(error);
    }
    return status;
}
async function generateLlamaCppResponse(options) {
    const baseUrl = (0, config_js_1.getConfiguredLlamaBaseUrl)(options.config);
    const resolvedTemperature = options.overrides?.Temperature ?? (0, config_js_1.getConfiguredLlamaSetting)(options.config, 'Temperature');
    const resolvedTopP = options.overrides?.TopP ?? (0, config_js_1.getConfiguredLlamaSetting)(options.config, 'TopP');
    const resolvedMaxTokens = options.overrides?.MaxTokens ?? (0, config_js_1.getConfiguredLlamaSetting)(options.config, 'MaxTokens');
    const resolvedTopK = options.overrides?.TopK ?? (0, config_js_1.getConfiguredLlamaSetting)(options.config, 'TopK');
    const resolvedMinP = options.overrides?.MinP ?? (0, config_js_1.getConfiguredLlamaSetting)(options.config, 'MinP');
    const resolvedPresencePenalty = options.overrides?.PresencePenalty ?? (0, config_js_1.getConfiguredLlamaSetting)(options.config, 'PresencePenalty');
    const resolvedRepetitionPenalty = options.overrides?.RepetitionPenalty ?? (0, config_js_1.getConfiguredLlamaSetting)(options.config, 'RepetitionPenalty');
    const requestBody = JSON.stringify({
        model: options.model,
        messages: [
            {
                role: 'user',
                content: options.prompt,
            },
        ],
        ...(resolvedTemperature === undefined ? {} : { temperature: Number(resolvedTemperature) }),
        ...(resolvedTopP === undefined ? {} : { top_p: Number(resolvedTopP) }),
        ...(resolvedMaxTokens === undefined || resolvedMaxTokens === null ? {} : { max_tokens: Number(resolvedMaxTokens) }),
        extra_body: {
            ...(resolvedTopK === undefined ? {} : { top_k: Number(resolvedTopK) }),
            ...(resolvedMinP === undefined ? {} : { min_p: Number(resolvedMinP) }),
            ...(resolvedPresencePenalty === undefined ? {} : { presence_penalty: Number(resolvedPresencePenalty) }),
            ...(resolvedRepetitionPenalty === undefined ? {} : { repeat_penalty: Number(resolvedRepetitionPenalty) }),
        },
    });
    const response = await requestJson({
        url: `${baseUrl.replace(/\/$/u, '')}/v1/chat/completions`,
        method: 'POST',
        timeoutMs: options.timeoutSeconds * 1000,
        body: requestBody,
    });
    if (response.statusCode >= 400) {
        const detail = response.rawText.trim();
        throw new Error(`llama.cpp generate failed with HTTP ${response.statusCode}${detail ? `: ${detail}` : '.'}`);
    }
    const firstChoice = response.body.choices?.[0];
    const messageText = getTextContent(firstChoice?.message?.content);
    const reasoningText = getTextContent(firstChoice?.message?.reasoning_content);
    const text = (messageText || firstChoice?.text || '').trim();
    if (!text) {
        throw new Error('llama.cpp did not return a response body.');
    }
    const rawUsage = response.body.usage;
    const thinkingTokens = getThinkingTokenCount(rawUsage) ?? await countLlamaCppTokens(options.config, reasoningText);
    const usage = rawUsage
        ? {
            promptTokens: getUsageValue(rawUsage.prompt_tokens),
            completionTokens: subtractThinkingTokens(getUsageValue(rawUsage.completion_tokens), thinkingTokens),
            totalTokens: getUsageValue(rawUsage.total_tokens),
            thinkingTokens,
        }
        : null;
    return {
        text,
        usage,
    };
}
