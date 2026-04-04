"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getConfigServiceUrl = getConfigServiceUrl;
exports.saveConfig = saveConfig;
exports.loadConfig = loadConfig;
exports.setTopLevelConfigKey = setTopLevelConfigKey;
const http_js_1 = require("../lib/http.js");
const effective_js_1 = require("./effective.js");
const normalization_js_1 = require("./normalization.js");
const status_backend_js_1 = require("./status-backend.js");
function getConfigServiceUrl() {
    const configuredUrl = process.env.SIFTKIT_CONFIG_SERVICE_URL;
    if (configuredUrl && configuredUrl.trim()) {
        return configuredUrl.trim();
    }
    return (0, status_backend_js_1.deriveServiceUrl)((0, status_backend_js_1.getStatusBackendUrl)(), '/config');
}
async function getConfigFromService() {
    try {
        return await (0, http_js_1.requestJson)({
            url: getConfigServiceUrl(),
            method: 'GET',
            timeoutMs: 130_000,
        });
    }
    catch {
        throw (0, status_backend_js_1.toStatusServerUnavailableError)();
    }
}
async function setConfigInService(config) {
    try {
        return await (0, http_js_1.requestJson)({
            url: getConfigServiceUrl(),
            method: 'PUT',
            timeoutMs: 2000,
            body: JSON.stringify((0, normalization_js_1.toPersistedConfigObject)(config)),
        });
    }
    catch {
        throw (0, status_backend_js_1.toStatusServerUnavailableError)();
    }
}
async function saveConfig(config) {
    return setConfigInService(config);
}
async function loadConfig(options) {
    void options;
    const config = await getConfigFromService();
    const update = (0, normalization_js_1.normalizeConfig)(config);
    if (update.info.changed) {
        await saveConfig(update.config);
    }
    const runtimeBackfilled = (0, normalization_js_1.applyRuntimeCompatibilityView)(update.config);
    return (0, effective_js_1.addEffectiveConfigProperties)((0, normalization_js_1.updateRuntimePaths)(runtimeBackfilled), update.info);
}
async function setTopLevelConfigKey(key, value) {
    const config = await loadConfig({ ensure: true });
    if (!Object.prototype.hasOwnProperty.call(config, key)) {
        throw new Error(`Unknown top-level config key: ${key}`);
    }
    config[key] = value;
    await saveConfig(config);
    return loadConfig({ ensure: true });
}
