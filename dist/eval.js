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
exports.runEvaluation = runEvaluation;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const config_js_1 = require("./config.js");
const summary_js_1 = require("./summary.js");
const execution_lock_js_1 = require("./execution-lock.js");
function getRepoRoot() {
    return path.resolve(__dirname, '..', '..');
}
function getFixtureManifest(fixtureRoot) {
    const manifestPath = path.join(fixtureRoot, 'fixtures.json');
    return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
}
function getTimestamp() {
    const current = new Date();
    const yyyy = current.getFullYear();
    const MM = String(current.getMonth() + 1).padStart(2, '0');
    const dd = String(current.getDate()).padStart(2, '0');
    const hh = String(current.getHours()).padStart(2, '0');
    const mm = String(current.getMinutes()).padStart(2, '0');
    const ss = String(current.getSeconds()).padStart(2, '0');
    const fff = String(current.getMilliseconds()).padStart(3, '0');
    return `${yyyy}${MM}${dd}_${hh}${mm}${ss}_${fff}`;
}
function newArtifactPath(directory, prefix, extension) {
    const safeExtension = extension.replace(/^\./u, '');
    const suffix = `${getTimestamp()}_${process.pid}_${Math.random().toString(16).slice(2, 10)}`;
    return path.join(directory, `${prefix}_${suffix}.${safeExtension}`);
}
function getFixtureScore(summary, fixture, sourceLength) {
    const required = fixture.RequiredTerms || [];
    const forbidden = fixture.ForbiddenTerms || [];
    const matchedRequired = required.filter((term) => term && summary.includes(term)).length;
    const matchedForbidden = forbidden.filter((term) => term && summary.includes(term)).length;
    const recall = required.length === 0 ? 2 : (matchedRequired === required.length ? 2 : (matchedRequired > 0 ? 1 : 0));
    const precision = matchedForbidden === 0 ? 2 : (matchedForbidden < Math.max(forbidden.length, 1) ? 1 : 0);
    const faithfulness = recall === 2 && precision === 2 ? 2 : (recall > 0 && precision > 0 ? 1 : 0);
    let formatScore = 2;
    if (fixture.Format === 'json') {
        try {
            JSON.parse(summary);
        }
        catch {
            formatScore = 0;
        }
    }
    const ratio = sourceLength > 0 ? (summary.length / sourceLength) : 1;
    const compression = ratio <= 0.6 ? 2 : (ratio <= 0.85 ? 1 : 0);
    return {
        Recall: recall,
        Precision: precision,
        Faithfulness: faithfulness,
        Format: formatScore,
        Compression: compression,
        Total: recall + precision + faithfulness + formatScore + compression,
        Notes: `required matched: ${matchedRequired}/${required.length}; forbidden matched: ${matchedForbidden}/${forbidden.length}`,
    };
}
async function runEvaluation(request) {
    return (0, execution_lock_js_1.withExecutionLock)(async () => {
        const config = await (0, config_js_1.loadConfig)({ ensure: true });
        const backend = request.Backend || config.Backend;
        const model = request.Model || config.Model;
        const fixtureRoot = request.FixtureRoot || path.join(getRepoRoot(), 'eval', 'fixtures');
        const manifest = getFixtureManifest(fixtureRoot);
        const results = [];
        for (const fixture of manifest) {
            const sourcePath = path.join(fixtureRoot, fixture.File);
            const source = fs.readFileSync(sourcePath, 'utf8');
            const summaryResult = await (0, summary_js_1.summarizeRequest)({
                question: fixture.Question,
                inputText: source,
                format: fixture.Format,
                backend,
                model,
                policyProfile: fixture.PolicyProfile,
            });
            const score = getFixtureScore(summaryResult.Summary, fixture, source.length);
            results.push({
                Name: fixture.Name,
                SourcePath: sourcePath,
                WasSummarized: summaryResult.WasSummarized,
                Summary: summaryResult.Summary,
                Recall: score.Recall,
                Precision: score.Precision,
                Faithfulness: score.Faithfulness,
                Format: score.Format,
                Compression: score.Compression,
                Total: score.Total,
                Notes: score.Notes,
            });
        }
        for (const logPath of request.RealLogPath || []) {
            if (!fs.existsSync(logPath)) {
                continue;
            }
            const source = fs.readFileSync(logPath, 'utf8');
            const summaryResult = await (0, summary_js_1.summarizeRequest)({
                question: 'Summarize the important result in up to 5 bullets, preserving only the decisive facts.',
                inputText: source,
                format: 'text',
                backend,
                model,
                policyProfile: 'general',
            });
            results.push({
                Name: `RealLog:${path.basename(logPath)}`,
                SourcePath: logPath,
                WasSummarized: summaryResult.WasSummarized,
                Summary: summaryResult.Summary,
                Recall: null,
                Precision: null,
                Faithfulness: null,
                Format: null,
                Compression: null,
                Total: null,
                Notes: 'Manual review required for real-log scoring.',
            });
        }
        const paths = (0, config_js_1.initializeRuntime)();
        const resultPath = newArtifactPath(paths.EvalResults, 'evaluation', 'json');
        (0, config_js_1.saveContentAtomically)(resultPath, JSON.stringify(results, null, 2));
        return {
            Backend: backend,
            Model: model,
            ResultPath: resultPath,
            Results: results,
        };
    });
}
