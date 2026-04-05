"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.analyzeCommandOutput = analyzeCommandOutput;
exports.runCommand = runCommand;
const config_js_1 = require("./config.js");
const summary_js_1 = require("./summary.js");
const execution_lock_js_1 = require("./execution-lock.js");
const artifacts_js_1 = require("./capture/artifacts.js");
const process_js_1 = require("./capture/process.js");
function compressRepeatedLines(lines) {
    if (lines.length === 0) {
        return [];
    }
    const result = [];
    let current = lines[0];
    let count = 1;
    for (let index = 1; index < lines.length; index += 1) {
        if (lines[index] === current) {
            count += 1;
            continue;
        }
        if (count > 3) {
            result.push(`${current} [repeated ${count} times]`);
        }
        else {
            for (let repeat = 0; repeat < count; repeat += 1) {
                result.push(current);
            }
        }
        current = lines[index];
        count = 1;
    }
    if (count > 3) {
        result.push(`${current} [repeated ${count} times]`);
    }
    else {
        for (let repeat = 0; repeat < count; repeat += 1) {
            result.push(current);
        }
    }
    return result;
}
function getErrorContextLines(lines) {
    const pattern = /(error|exception|failed|fatal|denied|timeout|traceback|panic|duplicate key|destroy)/iu;
    const indexes = lines.reduce((result, line, index) => {
        if (pattern.test(line)) {
            result.push(index);
        }
        return result;
    }, []);
    if (indexes.length === 0) {
        return [];
    }
    const selected = [];
    const seen = new Set();
    for (const index of indexes) {
        const start = Math.max(index - 2, 0);
        const end = Math.min(index + 2, lines.length - 1);
        for (let cursor = start; cursor <= end; cursor += 1) {
            if (!seen.has(cursor)) {
                seen.add(cursor);
                selected.push(lines[cursor]);
            }
        }
    }
    return selected;
}
function reduceText(text, reducerProfile) {
    if (reducerProfile === 'none') {
        return text;
    }
    const lines = text.length > 0 ? text.replace(/\r\n/gu, '\n').split('\n') : [];
    if (lines.length <= 200) {
        return text;
    }
    const compressed = compressRepeatedLines(lines);
    switch (reducerProfile) {
        case 'errors': {
            const context = getErrorContextLines(compressed);
            return context.length > 0 ? context.join('\n') : compressed.slice(-120).join('\n');
        }
        case 'tail':
            return compressed.slice(-160).join('\n');
        case 'diff': {
            const diffLines = compressed.filter((line) => /^(diff --git|\+\+\+|---|@@|\+[^+]|-[^-]|index\s|rename |new file mode|deleted file mode)/u.test(line));
            return diffLines.length > 0 ? diffLines.join('\n') : compressed.slice(0, 80).join('\n');
        }
        default: {
            const context = getErrorContextLines(compressed);
            if (context.length > 0) {
                return [...compressed.slice(0, 20), '', ...context, '', ...compressed.slice(-40)].join('\n');
            }
            return [...compressed.slice(0, 40), '', ...compressed.slice(-80)].join('\n');
        }
    }
}
async function analyzeCommandOutput(request) {
    const config = await (0, config_js_1.loadConfig)({ ensure: true });
    const backend = request.Backend || config.Backend;
    const model = request.Model || (0, config_js_1.getConfiguredModel)(config);
    const paths = (0, config_js_1.initializeRuntime)();
    const combinedText = request.CombinedText || '';
    const rawLogPath = (0, artifacts_js_1.newArtifactPath)(paths.Logs, 'command_raw', 'log');
    (0, config_js_1.saveContentAtomically)(rawLogPath, combinedText);
    const question = request.Question || 'Summarize the main result and any actionable failures.';
    const riskLevel = request.RiskLevel || 'informational';
    const reducerProfile = request.ReducerProfile || 'smart';
    const format = request.Format || 'text';
    const policyProfile = request.PolicyProfile || 'general';
    const decision = (0, summary_js_1.getSummaryDecision)(combinedText, question, riskLevel, config, {
        sourceKind: 'command-output',
        commandExitCode: request.ExitCode,
    });
    const reducedText = reduceText(combinedText, reducerProfile);
    const deterministicExcerpt = (0, summary_js_1.getDeterministicExcerpt)(combinedText, question);
    let reducedLogPath = null;
    if (reducedText !== combinedText) {
        reducedLogPath = (0, artifacts_js_1.newArtifactPath)(paths.Logs, 'command_reduced', 'log');
        (0, config_js_1.saveContentAtomically)(reducedLogPath, reducedText);
    }
    if (request.NoSummarize || !decision.ShouldSummarize) {
        return {
            ExitCode: request.ExitCode,
            RawLogPath: rawLogPath,
            ReducedLogPath: reducedLogPath,
            WasSummarized: false,
            PolicyDecision: request.NoSummarize ? 'no-summarize' : decision.Reason,
            Classification: 'no-summarize',
            RawReviewRequired: decision.RawReviewRequired,
            ModelCallSucceeded: false,
            ProviderError: null,
            Summary: deterministicExcerpt ? `Raw review required.\nRaw log: ${rawLogPath}\n${deterministicExcerpt}` : null,
        };
    }
    const effectiveProfile = ((riskLevel === 'debug' || riskLevel === 'risky') && policyProfile === 'general')
        ? 'risky-operation'
        : policyProfile;
    const summaryResult = await (0, summary_js_1.summarizeRequest)({
        question,
        inputText: combinedText,
        format,
        policyProfile: effectiveProfile,
        backend,
        model,
        sourceKind: 'command-output',
        commandExitCode: request.ExitCode,
        debugCommand: request.CommandText,
    });
    const summaryText = summaryResult.RawReviewRequired && summaryResult.Classification !== 'unsupported_input' && summaryResult.Summary.trim()
        ? `${summaryResult.Summary.trim()}\nRaw log: ${rawLogPath}`
        : summaryResult.Summary;
    return {
        ExitCode: request.ExitCode,
        RawLogPath: rawLogPath,
        ReducedLogPath: reducedLogPath,
        WasSummarized: summaryResult.WasSummarized,
        PolicyDecision: summaryResult.PolicyDecision,
        Classification: summaryResult.Classification,
        RawReviewRequired: summaryResult.RawReviewRequired,
        ModelCallSucceeded: summaryResult.ModelCallSucceeded,
        ProviderError: summaryResult.ProviderError,
        Summary: summaryText,
    };
}
async function runCommand(request) {
    return (0, execution_lock_js_1.withExecutionLock)(async () => {
        const processResult = (0, process_js_1.invokeProcess)(request.Command, request.ArgumentList || []);
        return analyzeCommandOutput({
            ExitCode: processResult.ExitCode,
            CombinedText: processResult.Combined,
            CommandText: [request.Command, ...(request.ArgumentList || [])].join(' '),
            Question: request.Question,
            RiskLevel: request.RiskLevel,
            ReducerProfile: request.ReducerProfile,
            Format: request.Format,
            PolicyProfile: request.PolicyProfile,
            Backend: request.Backend,
            Model: request.Model,
            NoSummarize: request.NoSummarize,
        });
    });
}
