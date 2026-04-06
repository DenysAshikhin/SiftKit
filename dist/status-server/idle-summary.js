"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildIdleSummarySnapshot = buildIdleSummarySnapshot;
exports.buildIdleSummarySnapshotMessage = buildIdleSummarySnapshotMessage;
exports.buildIdleMetricsLogMessage = buildIdleMetricsLogMessage;
exports.ensureIdleSummarySnapshotsTable = ensureIdleSummarySnapshotsTable;
exports.persistIdleSummarySnapshot = persistIdleSummarySnapshot;
exports.normalizeIdleSummarySnapshotRowNumber = normalizeIdleSummarySnapshotRowNumber;
exports.querySnapshotTotalsBeforeDate = querySnapshotTotalsBeforeDate;
exports.querySnapshotTimeseries = querySnapshotTimeseries;
exports.queryRecentSnapshots = queryRecentSnapshots;
const formatting_js_1 = require("./formatting.js");
function buildIdleSummarySnapshot(metrics, emittedAt = new Date()) {
    const inputTokensTotal = Number(metrics.inputTokensTotal) || 0;
    const outputTokensTotal = Number(metrics.outputTokensTotal) || 0;
    const thinkingTokensTotal = Number(metrics.thinkingTokensTotal) || 0;
    const promptCacheTokensTotal = Number(metrics.promptCacheTokensTotal) || 0;
    const promptEvalTokensTotal = Number(metrics.promptEvalTokensTotal) || 0;
    const inputCharactersTotal = Number(metrics.inputCharactersTotal) || 0;
    const outputCharactersTotal = Number(metrics.outputCharactersTotal) || 0;
    const requestDurationMsTotal = Number(metrics.requestDurationMsTotal) || 0;
    const completedRequestCount = Number(metrics.completedRequestCount) || 0;
    const savedTokens = inputTokensTotal - outputTokensTotal;
    const savedPercent = inputTokensTotal > 0 ? savedTokens / inputTokensTotal : Number.NaN;
    const compressionRatio = outputTokensTotal > 0 ? inputTokensTotal / outputTokensTotal : Number.NaN;
    const avgOutputTokensPerRequest = completedRequestCount > 0 ? outputTokensTotal / completedRequestCount : Number.NaN;
    const avgRequestMs = completedRequestCount > 0 ? requestDurationMsTotal / completedRequestCount : Number.NaN;
    const avgTokensPerSecond = requestDurationMsTotal > 0 && outputTokensTotal > 0
        ? outputTokensTotal / (requestDurationMsTotal / 1000)
        : Number.NaN;
    const inputCharactersPerContextToken = Number.isFinite(metrics.inputCharactersPerContextToken) && Number(metrics.inputCharactersPerContextToken) > 0
        ? Number(metrics.inputCharactersPerContextToken)
        : null;
    const chunkThresholdCharacters = Number.isFinite(metrics.chunkThresholdCharacters) && Number(metrics.chunkThresholdCharacters) > 0
        ? Number(metrics.chunkThresholdCharacters)
        : null;
    return {
        emittedAtUtc: emittedAt.toISOString(),
        inputTokensTotal,
        outputTokensTotal,
        thinkingTokensTotal,
        promptCacheTokensTotal,
        promptEvalTokensTotal,
        inputCharactersTotal,
        outputCharactersTotal,
        requestDurationMsTotal,
        completedRequestCount,
        savedTokens,
        savedPercent,
        compressionRatio,
        avgOutputTokensPerRequest,
        avgRequestMs,
        avgTokensPerSecond,
        inputCharactersPerContextToken,
        chunkThresholdCharacters,
    };
}
function formatIdleSummarySection(label, content, colorCode, colorOptions = {}) {
    const visibleLabel = `${label}:`;
    const spacing = ' '.repeat(Math.max(1, 8 - visibleLabel.length));
    return `  ${(0, formatting_js_1.colorize)(label, colorCode, colorOptions)}:${spacing}${content}`;
}
function buildIdleSummarySnapshotMessage(snapshot, colorOptions = {}) {
    const lines = [
        `requests=${(0, formatting_js_1.formatInteger)(snapshot.completedRequestCount)}`,
        formatIdleSummarySection('input', `chars=${(0, formatting_js_1.formatInteger)(snapshot.inputCharactersTotal)} tokens=${(0, formatting_js_1.formatInteger)(snapshot.inputTokensTotal)}`, 36, colorOptions),
        formatIdleSummarySection('output', `chars=${(0, formatting_js_1.formatInteger)(snapshot.outputCharactersTotal)} tokens=${(0, formatting_js_1.formatInteger)(snapshot.outputTokensTotal)} avg_tokens_per_request=${(0, formatting_js_1.formatGroupedNumber)(snapshot.avgOutputTokensPerRequest, 2)}`, 32, colorOptions),
        formatIdleSummarySection('saved', `tokens=${(0, formatting_js_1.formatInteger)(snapshot.savedTokens)} pct=${(0, formatting_js_1.formatPercentage)(snapshot.savedPercent)} ratio=${(0, formatting_js_1.formatRatio)(snapshot.compressionRatio)}`, 33, colorOptions),
    ];
    const budgetParts = [];
    if (snapshot.inputCharactersPerContextToken !== null) {
        budgetParts.push(`chars_per_token=${(0, formatting_js_1.formatGroupedNumber)(snapshot.inputCharactersPerContextToken, 3)}`);
    }
    if (snapshot.chunkThresholdCharacters !== null) {
        budgetParts.push(`chunk_threshold_chars=${(0, formatting_js_1.formatInteger)(snapshot.chunkThresholdCharacters)}`);
    }
    if (budgetParts.length > 0) {
        lines.push(formatIdleSummarySection('budget', budgetParts.join(' '), 35, colorOptions));
    }
    lines.push(formatIdleSummarySection('timing', `total=${(0, formatting_js_1.formatElapsed)(snapshot.requestDurationMsTotal)} avg_request=${(0, formatting_js_1.formatSeconds)(snapshot.avgRequestMs)} gen_tokens_per_s=${(0, formatting_js_1.formatTokensPerSecond)(snapshot.avgTokensPerSecond)}`, 34, colorOptions));
    return lines.join('\n');
}
function buildIdleMetricsLogMessage(metrics, colorOptions = {}) {
    return buildIdleSummarySnapshotMessage(buildIdleSummarySnapshot(metrics), colorOptions);
}
function normalizeSqlNumber(value) {
    return Number.isFinite(value) ? Number(value) : null;
}
function ensureIdleSummarySnapshotsTable(database) {
    database.exec(`
    CREATE TABLE IF NOT EXISTS idle_summary_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      emitted_at_utc TEXT NOT NULL,
      completed_request_count INTEGER NOT NULL,
      input_characters_total INTEGER NOT NULL,
      output_characters_total INTEGER NOT NULL,
      input_tokens_total INTEGER NOT NULL,
      output_tokens_total INTEGER NOT NULL,
      thinking_tokens_total INTEGER NOT NULL,
      prompt_cache_tokens_total INTEGER NOT NULL DEFAULT 0,
      prompt_eval_tokens_total INTEGER NOT NULL DEFAULT 0,
      saved_tokens INTEGER NOT NULL,
      saved_percent REAL,
      compression_ratio REAL,
      request_duration_ms_total INTEGER NOT NULL,
      avg_request_ms REAL,
      avg_tokens_per_second REAL
    );
  `);
    const existingColumns = database.prepare('PRAGMA table_info(idle_summary_snapshots)').all()
        .map((column) => String(column.name));
    if (!existingColumns.includes('thinking_tokens_total')) {
        database.exec('ALTER TABLE idle_summary_snapshots ADD COLUMN thinking_tokens_total INTEGER NOT NULL DEFAULT 0;');
    }
    if (!existingColumns.includes('prompt_cache_tokens_total')) {
        database.exec('ALTER TABLE idle_summary_snapshots ADD COLUMN prompt_cache_tokens_total INTEGER NOT NULL DEFAULT 0;');
    }
    if (!existingColumns.includes('prompt_eval_tokens_total')) {
        database.exec('ALTER TABLE idle_summary_snapshots ADD COLUMN prompt_eval_tokens_total INTEGER NOT NULL DEFAULT 0;');
    }
}
function persistIdleSummarySnapshot(database, snapshot) {
    database.prepare(`
    INSERT INTO idle_summary_snapshots (
      emitted_at_utc,
      completed_request_count,
      input_characters_total,
      output_characters_total,
      input_tokens_total,
      output_tokens_total,
      thinking_tokens_total,
      prompt_cache_tokens_total,
      prompt_eval_tokens_total,
      saved_tokens,
      saved_percent,
      compression_ratio,
      request_duration_ms_total,
      avg_request_ms,
      avg_tokens_per_second
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(snapshot.emittedAtUtc, snapshot.completedRequestCount, snapshot.inputCharactersTotal, snapshot.outputCharactersTotal, snapshot.inputTokensTotal, snapshot.outputTokensTotal, snapshot.thinkingTokensTotal, snapshot.promptCacheTokensTotal, snapshot.promptEvalTokensTotal, snapshot.savedTokens, normalizeSqlNumber(snapshot.savedPercent), normalizeSqlNumber(snapshot.compressionRatio), snapshot.requestDurationMsTotal, normalizeSqlNumber(snapshot.avgRequestMs), normalizeSqlNumber(snapshot.avgTokensPerSecond));
}
function normalizeIdleSummarySnapshotRowNumber(value) {
    return normalizeSqlNumber(value);
}
function querySnapshotTotalsBeforeDate(database, dateKey) {
    if (!database) {
        return null;
    }
    const row = database
        .prepare(`
      SELECT
        completed_request_count,
        input_tokens_total,
        output_tokens_total,
        thinking_tokens_total,
        prompt_cache_tokens_total,
        prompt_eval_tokens_total,
        request_duration_ms_total
      FROM idle_summary_snapshots
      WHERE emitted_at_utc < ?
      ORDER BY emitted_at_utc DESC, id DESC
      LIMIT 1
    `)
        .get(`${dateKey}T00:00:00.000Z`);
    if (!row || typeof row !== 'object') {
        return null;
    }
    return {
        completedRequestCount: Number(row.completed_request_count) || 0,
        inputTokensTotal: Number(row.input_tokens_total) || 0,
        outputTokensTotal: Number(row.output_tokens_total) || 0,
        thinkingTokensTotal: Number(row.thinking_tokens_total) || 0,
        promptCacheTokensTotal: Number(row.prompt_cache_tokens_total) || 0,
        promptEvalTokensTotal: Number(row.prompt_eval_tokens_total) || 0,
        requestDurationMsTotal: Number(row.request_duration_ms_total) || 0,
    };
}
function querySnapshotTimeseries(database) {
    if (!database) {
        return [];
    }
    return database
        .prepare(`
      SELECT
        emitted_at_utc,
        completed_request_count,
        input_tokens_total,
        output_tokens_total,
        thinking_tokens_total,
        prompt_cache_tokens_total,
        prompt_eval_tokens_total,
        request_duration_ms_total
      FROM idle_summary_snapshots
      ORDER BY emitted_at_utc ASC, id ASC
    `)
        .all();
}
function queryRecentSnapshots(database, limit) {
    return database
        .prepare(`
      SELECT emitted_at_utc, completed_request_count, input_characters_total, output_characters_total,
             input_tokens_total, output_tokens_total, thinking_tokens_total, prompt_cache_tokens_total,
             prompt_eval_tokens_total, saved_tokens, saved_percent, compression_ratio,
             request_duration_ms_total, avg_request_ms, avg_tokens_per_second
      FROM idle_summary_snapshots ORDER BY id DESC LIMIT ?
    `)
        .all(limit);
}
