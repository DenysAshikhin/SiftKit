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
function getUsageValue(value) {
    return Number.isFinite(value) && Number(value) >= 0 ? Number(value) : null;
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
                    resolve({ statusCode: response.statusCode || 0, body: {} });
                    return;
                }
                try {
                    resolve({
                        statusCode: response.statusCode || 0,
                        body: JSON.parse(responseText),
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
async function listLlamaCppModels(config) {
    const response = await requestJson({
        url: `${config.LlamaCpp.BaseUrl.replace(/\/$/u, '')}/v1/models`,
        method: 'GET',
        timeoutMs: 5000,
    });
    if (response.statusCode >= 400) {
        throw new Error(`llama.cpp model list failed with HTTP ${response.statusCode}.`);
    }
    return (response.body.data || [])
        .map((entry) => entry.id)
        .filter((value) => Boolean(value && value.trim()));
}
async function getLlamaCppProviderStatus(config) {
    const status = {
        Available: true,
        Reachable: false,
        BaseUrl: config.LlamaCpp.BaseUrl,
        Error: null,
    };
    try {
        await listLlamaCppModels(config);
        status.Reachable = true;
    }
    catch (error) {
        status.Error = error instanceof Error ? error.message : String(error);
    }
    return status;
}
async function generateLlamaCppResponse(options) {
    const requestBody = JSON.stringify({
        model: options.model,
        messages: [
            {
                role: 'user',
                content: options.prompt,
            },
        ],
        temperature: Number(options.config.LlamaCpp.Temperature),
        top_p: Number(options.config.LlamaCpp.TopP),
        ...(options.config.LlamaCpp.MaxTokens === undefined || options.config.LlamaCpp.MaxTokens === null
            ? {}
            : { max_tokens: Number(options.config.LlamaCpp.MaxTokens) }),
        extra_body: {
            top_k: Number(options.config.LlamaCpp.TopK),
            min_p: Number(options.config.LlamaCpp.MinP),
            presence_penalty: Number(options.config.LlamaCpp.PresencePenalty),
            repeat_penalty: Number(options.config.LlamaCpp.RepetitionPenalty),
        },
    });
    const response = await requestJson({
        url: `${options.config.LlamaCpp.BaseUrl.replace(/\/$/u, '')}/v1/chat/completions`,
        method: 'POST',
        timeoutMs: options.timeoutSeconds * 1000,
        body: requestBody,
    });
    if (response.statusCode >= 400) {
        throw new Error(`llama.cpp generate failed with HTTP ${response.statusCode}.`);
    }
    const firstChoice = response.body.choices?.[0];
    const messageText = getTextContent(firstChoice?.message?.content);
    const text = (messageText || firstChoice?.text || '').trim();
    if (!text) {
        throw new Error('llama.cpp did not return a response body.');
    }
    const usage = response.body.usage
        ? {
            promptTokens: getUsageValue(response.body.usage.prompt_tokens),
            completionTokens: getUsageValue(response.body.usage.completion_tokens),
            totalTokens: getUsageValue(response.body.usage.total_tokens),
        }
        : null;
    return {
        text,
        usage,
    };
}
