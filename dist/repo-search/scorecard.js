"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getOutputCharacterCount = getOutputCharacterCount;
exports.getNumericTotal = getNumericTotal;
function getOutputCharacterCount(scorecard) {
    const tasks = (scorecard
        && typeof scorecard === 'object'
        && !Array.isArray(scorecard)
        && Array.isArray(scorecard.tasks))
        ? scorecard.tasks
        : [];
    if (tasks.length === 0) {
        return 0;
    }
    const outputText = tasks
        .map((task) => (typeof task?.finalOutput === 'string' ? task.finalOutput.trim() : ''))
        .filter((value) => value.length > 0)
        .join('\n\n');
    return outputText.length;
}
function getNumericTotal(scorecard, key) {
    if (!scorecard || typeof scorecard !== 'object' || Array.isArray(scorecard)) {
        return null;
    }
    const totals = scorecard.totals;
    if (!totals || typeof totals !== 'object' || Array.isArray(totals)) {
        return null;
    }
    const rawValue = totals[key];
    return Number.isFinite(rawValue) && Number(rawValue) >= 0 ? Number(rawValue) : null;
}
