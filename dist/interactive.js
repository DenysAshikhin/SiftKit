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
exports.runInteractiveCapture = runInteractiveCapture;
const fs = __importStar(require("node:fs"));
const index_js_1 = require("./config/index.js");
const fs_js_1 = require("./lib/fs.js");
const summary_js_1 = require("./summary.js");
const artifacts_js_1 = require("./capture/artifacts.js");
const command_path_js_1 = require("./capture/command-path.js");
const process_js_1 = require("./capture/process.js");
async function runInteractiveCapture(request) {
    const config = await (0, index_js_1.loadConfig)({ ensure: true });
    const backend = request.Backend || config.Backend;
    const model = request.Model || (0, index_js_1.getConfiguredModel)(config);
    const format = request.Format || 'text';
    const policyProfile = request.PolicyProfile || 'general';
    const question = request.Question || 'Summarize the important result and any actionable failures.';
    const paths = (0, index_js_1.initializeRuntime)();
    const transcriptPath = (0, artifacts_js_1.newArtifactPath)(paths.Logs, 'interactive_raw', 'log');
    const resolvedCommand = (0, command_path_js_1.resolveExternalCommand)(request.Command);
    let exitCode = 0;
    try {
        exitCode = (0, process_js_1.captureWithTranscript)(resolvedCommand, request.ArgumentList || [], transcriptPath);
    }
    catch {
        (0, fs_js_1.saveContentAtomically)(transcriptPath, '');
        exitCode = 1;
    }
    let transcriptText = fs.existsSync(transcriptPath) ? fs.readFileSync(transcriptPath, 'utf8') : '';
    if (config.Interactive.MaxTranscriptCharacters && transcriptText.length > Number(config.Interactive.MaxTranscriptCharacters)) {
        transcriptText = transcriptText.substring(transcriptText.length - Number(config.Interactive.MaxTranscriptCharacters));
        (0, fs_js_1.saveContentAtomically)(transcriptPath, transcriptText);
    }
    if (!transcriptText.trim()) {
        transcriptText = `Interactive command completed without a captured transcript.\nCommand: ${request.Command} ${(request.ArgumentList || []).join(' ')}\nExitCode: ${exitCode}`;
        (0, fs_js_1.saveContentAtomically)(transcriptPath, transcriptText);
    }
    const summaryResult = await (0, summary_js_1.summarizeRequest)({
        question,
        inputText: transcriptText,
        format,
        backend,
        model,
        policyProfile,
        sourceKind: 'command-output',
        commandExitCode: exitCode,
    });
    const outputText = `${(summaryResult.Summary || 'No summary generated.').trim()}\nRaw transcript: ${transcriptPath}`;
    return {
        ExitCode: exitCode,
        TranscriptPath: transcriptPath,
        WasSummarized: summaryResult.WasSummarized,
        RawReviewRequired: summaryResult.RawReviewRequired || exitCode !== 0,
        OutputText: outputText,
        Summary: summaryResult.Summary,
        Classification: summaryResult.Classification,
        PolicyDecision: summaryResult.PolicyDecision,
    };
}
