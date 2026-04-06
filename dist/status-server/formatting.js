"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.colorize = exports.supportsAnsiColor = exports.formatTokensPerSecond = exports.formatRatio = exports.formatPercentage = exports.formatSeconds = exports.formatMilliseconds = exports.formatInteger = exports.formatGroupedNumber = exports.formatElapsed = exports.formatTimestamp = void 0;
// Re-exports from shared lib for status-server backwards compatibility.
var text_format_js_1 = require("../lib/text-format.js");
Object.defineProperty(exports, "formatTimestamp", { enumerable: true, get: function () { return text_format_js_1.formatTimestamp; } });
Object.defineProperty(exports, "formatElapsed", { enumerable: true, get: function () { return text_format_js_1.formatElapsed; } });
Object.defineProperty(exports, "formatGroupedNumber", { enumerable: true, get: function () { return text_format_js_1.formatGroupedNumber; } });
Object.defineProperty(exports, "formatInteger", { enumerable: true, get: function () { return text_format_js_1.formatInteger; } });
Object.defineProperty(exports, "formatMilliseconds", { enumerable: true, get: function () { return text_format_js_1.formatMilliseconds; } });
Object.defineProperty(exports, "formatSeconds", { enumerable: true, get: function () { return text_format_js_1.formatSeconds; } });
Object.defineProperty(exports, "formatPercentage", { enumerable: true, get: function () { return text_format_js_1.formatPercentage; } });
Object.defineProperty(exports, "formatRatio", { enumerable: true, get: function () { return text_format_js_1.formatRatio; } });
Object.defineProperty(exports, "formatTokensPerSecond", { enumerable: true, get: function () { return text_format_js_1.formatTokensPerSecond; } });
Object.defineProperty(exports, "supportsAnsiColor", { enumerable: true, get: function () { return text_format_js_1.supportsAnsiColor; } });
Object.defineProperty(exports, "colorize", { enumerable: true, get: function () { return text_format_js_1.colorize; } });
