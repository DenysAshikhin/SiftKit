"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseJsonText = parseJsonText;
function parseJsonText(text) {
    const normalized = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
    return JSON.parse(normalized);
}
