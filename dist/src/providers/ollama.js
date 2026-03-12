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
exports.getOllamaLoadedModels = getOllamaLoadedModels;
exports.listOllamaModels = listOllamaModels;
exports.getOllamaProviderStatus = getOllamaProviderStatus;
exports.generateOllamaResponse = generateOllamaResponse;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const http = __importStar(require("node:http"));
const https = __importStar(require("node:https"));
const node_child_process_1 = require("node:child_process");
const config_js_1 = require("../config.js");
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
function getOllamaLoadedModels(executablePath) {
    const mockedOutput = process.env.SIFTKIT_TEST_OLLAMA_PS_OUTPUT;
    if (mockedOutput && mockedOutput.trim()) {
        return mockedOutput
            .split(/\r?\n/u)
            .slice(1)
            .filter((line) => line.trim().length > 0)
            .reduce((loadedModels, line) => {
            const parts = line.trim().split(/\s{2,}/u);
            if (parts.length < 5) {
                return loadedModels;
            }
            const parsedContext = Number.parseInt(parts[4], 10);
            loadedModels.push({
                Name: parts[0].trim(),
                Id: parts[1]?.trim() || null,
                Size: parts[2]?.trim() || null,
                Processor: parts[3]?.trim() || null,
                Context: Number.isFinite(parsedContext) ? parsedContext : null,
                Until: parts[5]?.trim() || null,
            });
            return loadedModels;
        }, []);
    }
    if (!executablePath || !fs.existsSync(executablePath)) {
        return [];
    }
    const extension = path.extname(executablePath).toLowerCase();
    const usesCommandShell = extension === '.cmd' || extension === '.bat';
    const result = usesCommandShell
        ? (0, node_child_process_1.spawnSync)('cmd.exe', ['/d', '/s', '/c', `"${executablePath}" ps`], { encoding: 'utf8' })
        : (0, node_child_process_1.spawnSync)(executablePath, ['ps'], { encoding: 'utf8' });
    if (result.status !== 0 || !result.stdout) {
        return [];
    }
    const lines = result.stdout.split(/\r?\n/u).slice(1).filter((line) => line.trim().length > 0);
    return lines.reduce((loadedModels, line) => {
        const parts = line.trim().split(/\s{2,}/u);
        if (parts.length < 5) {
            return loadedModels;
        }
        const parsedContext = Number.parseInt(parts[4], 10);
        loadedModels.push({
            Name: parts[0].trim(),
            Id: parts[1]?.trim() || null,
            Size: parts[2]?.trim() || null,
            Processor: parts[3]?.trim() || null,
            Context: Number.isFinite(parsedContext) ? parsedContext : null,
            Until: parts[5]?.trim() || null,
        });
        return loadedModels;
    }, []);
}
async function listOllamaModels(config) {
    try {
        const response = await requestJson({
            url: `${config.Ollama.BaseUrl.replace(/\/$/u, '')}/api/tags`,
            method: 'GET',
            timeoutMs: 5000,
        });
        const models = response.body.models?.map((entry) => entry.name).filter((value) => Boolean(value));
        if (models && models.length > 0) {
            return models;
        }
    }
    catch {
        // Fall back to the executable when the API is unavailable.
    }
    const executablePath = (0, config_js_1.findOllamaExecutable)();
    if (!executablePath) {
        return [];
    }
    const result = (0, node_child_process_1.spawnSync)(executablePath, ['list'], { encoding: 'utf8' });
    if (result.status !== 0 || !result.stdout) {
        return [];
    }
    return result.stdout
        .split(/\r?\n/u)
        .slice(1)
        .map((line) => line.split(/\s{2,}/u)[0]?.trim())
        .filter((value) => Boolean(value));
}
async function getOllamaProviderStatus(config) {
    const executablePath = (0, config_js_1.findOllamaExecutable)();
    const status = {
        Available: Boolean(executablePath),
        ExecutablePath: executablePath,
        Reachable: false,
        BaseUrl: config.Ollama.BaseUrl,
        Error: null,
        LoadedModelContext: null,
        LoadedModelName: null,
        RuntimeContextMatchesConfig: null,
    };
    try {
        const response = await requestJson({
            url: `${config.Ollama.BaseUrl.replace(/\/$/u, '')}/api/tags`,
            method: 'GET',
            timeoutMs: 3000,
        });
        if (Array.isArray(response.body.models)) {
            status.Reachable = true;
            status.Available = true;
        }
    }
    catch (error) {
        status.Error = error instanceof Error ? error.message : String(error);
    }
    const loadedModel = getOllamaLoadedModels(executablePath)
        .find((candidate) => candidate.Name === config.Model);
    if (loadedModel) {
        status.LoadedModelName = loadedModel.Name;
        status.LoadedModelContext = loadedModel.Context;
        if (loadedModel.Context !== null) {
            status.RuntimeContextMatchesConfig = Number(loadedModel.Context) === Number(config.Ollama.NumCtx);
        }
    }
    return status;
}
async function generateOllamaResponse(options) {
    const paths = (0, config_js_1.initializeRuntime)();
    const promptPath = path.join(paths.Logs, `ollama_prompt_${Date.now()}_${process.pid}_${Math.random().toString(16).slice(2, 10)}.txt`);
    (0, config_js_1.saveContentAtomically)(promptPath, options.prompt);
    const requestBody = JSON.stringify({
        model: options.model,
        prompt: options.prompt,
        stream: false,
        think: false,
        options: {
            temperature: Number(options.config.Ollama.Temperature),
            top_p: Number(options.config.Ollama.TopP),
            top_k: Number(options.config.Ollama.TopK),
            min_p: Number(options.config.Ollama.MinP),
            presence_penalty: Number(options.config.Ollama.PresencePenalty),
            repeat_penalty: Number(options.config.Ollama.RepetitionPenalty),
            num_ctx: Number(options.config.Ollama.NumCtx),
            ...(options.config.Ollama.NumPredict === undefined || options.config.Ollama.NumPredict === null
                ? {}
                : { num_predict: Number(options.config.Ollama.NumPredict) }),
        },
    });
    const response = await requestJson({
        url: `${options.config.Ollama.BaseUrl.replace(/\/$/u, '')}/api/generate`,
        method: 'POST',
        timeoutMs: options.timeoutSeconds * 1000,
        body: requestBody,
    });
    if (response.statusCode >= 400) {
        throw new Error(`Ollama generate failed with HTTP ${response.statusCode}. Prompt path: ${promptPath}`);
    }
    if (!response.body.response) {
        throw new Error('Ollama did not return a response body.');
    }
    return response.body;
}
