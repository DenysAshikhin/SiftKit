# External llama.cpp Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Do not use worktrees for this repo.

**Goal:** Add a settings option that points SiftKit at an already-running llama.cpp server on another host/port and disables local managed llama.cpp startup/shutdown while that option is enabled. If no local llama.cpp executable/model files are configured and no external server is configured yet, startup must not crash; it should log that no llama.cpp files were found and continue degraded until settings are completed.

**Architecture:** Keep the existing llama.cpp request path and queue semantics. Add one first-class config flag, `Server.LlamaCpp.ExternalServerEnabled`, that makes `BaseUrl` authoritative and turns managed process lifecycle into reachability checks only. Local managed startup remains best-effort: missing executable/model files produce a console warning and degraded status instead of a startup crash. The dashboard edits the flag per managed preset, syncs the selected preset to runtime config, and exposes a test button that calls a local status-server endpoint.

**Tech Stack:** TypeScript, Node status server, React dashboard, existing `requestText()` HTTP helper, `node:test`.

---

## File Structure

- Modify `src/config/types.ts`: add `ExternalServerEnabled?: boolean | null` to `ServerManagedLlamaCppConfig`.
- Modify `src/status-server/config-store.ts`: add defaults, normalization, persistence row mapping, `ManagedLlamaConfig.ExternalServerEnabled`, and runtime/preset field copying.
- Modify `src/config/normalization.ts`: add typed normalization/persistence support for `ExternalServerEnabled`.
- Modify `src/status-server/managed-llama.ts`: make external mode verify `/v1/models` and skip spawn/kill/cleanup; make missing local executable/model files log-and-degrade instead of throwing during startup.
- Modify `src/status-server/routes/core.ts`: add local `POST /config/llama-cpp/test` endpoint for dashboard validation.
- Modify `dashboard/src/types.ts`: add `ExternalServerEnabled` to dashboard config and preset types.
- Modify `dashboard/src/managed-llama-presets.ts`: copy the field between active preset and server config.
- Modify `dashboard/src/settings-runtime.ts`: keep `BaseUrl` sync unchanged; no runtime field is needed for the boolean.
- Modify `dashboard/src/tabs/settings/ManagedLlamaSection.tsx`: add an external-server toggle and a test button near `Base URL`.
- Modify `dashboard/tests/tab-components.test.tsx`: cover rendered toggle, disabling local launcher fields when external mode is enabled, and config mutation.
- Modify `tests/config.test.ts`: cover normalization/persistence for the new field.
- Modify `tests/managed-llama-blank-startup.test.ts`: cover external mode reachability and no local spawn requirement.
- Modify `tests/dashboard-status-server.test.ts`: cover the new test endpoint.

---

### Task 1: Config Types, Defaults, and Persistence

**Files:**
- Modify: `src/config/types.ts`
- Modify: `src/status-server/config-store.ts`
- Modify: `src/config/normalization.ts`
- Test: `tests/config.test.ts`

- [ ] **Step 1: Write failing config tests**

Add focused tests to `tests/config.test.ts` near existing managed llama normalization tests:

```ts
test('managed llama external server flag normalizes to false by default', () => {
  const { config } = normalizeConfig(getDefaultConfigObject());
  assert.equal(config.Server?.LlamaCpp?.ExternalServerEnabled, false);
});

test('managed llama external server flag persists when enabled', () => {
  const { config } = normalizeConfig({
    ...getDefaultConfigObject(),
    Server: {
      LlamaCpp: {
        ...getDefaultConfigObject().Server?.LlamaCpp,
        ExternalServerEnabled: true,
        BaseUrl: 'http://192.168.1.50:8097',
      },
    },
  });

  const persisted = toPersistedConfigObject(config);
  assert.equal(persisted.Server?.LlamaCpp?.ExternalServerEnabled, true);
  assert.equal(persisted.Server?.LlamaCpp?.BaseUrl, 'http://192.168.1.50:8097');
  assert.equal(persisted.Runtime?.LlamaCpp?.BaseUrl, 'http://192.168.1.50:8097');
});
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```powershell
npm test -- config
```

Expected: FAIL because `ExternalServerEnabled` is not typed or normalized.

- [ ] **Step 3: Add config type field**

In `src/config/types.ts`, update `ServerManagedLlamaCppConfig`:

```ts
export type ServerManagedLlamaCppConfig = {
  ExternalServerEnabled?: boolean | null;
  ExecutablePath?: string | null;
  BaseUrl?: string | null;
  BindHost?: string | null;
  Port?: number | null;
  ModelPath?: string | null;
  // existing fields unchanged
};
```

- [ ] **Step 4: Add status-server default and key lists**

In `src/status-server/config-store.ts`, add `ExternalServerEnabled: false` to:

```ts
const defaultManagedLlamaPreset = {
  id: 'default',
  label: 'Default',
  Model: DEFAULT_LLAMA_MODEL,
  ExternalServerEnabled: false,
  ExecutablePath: null,
  BaseUrl: DEFAULT_LLAMA_BASE_URL,
  // existing fields unchanged
};
```

Add `'ExternalServerEnabled'` before `'ExecutablePath'` in:

```ts
const MANAGED_LLAMA_FIELD_KEYS: readonly string[] = [
  'Model',
  'ExternalServerEnabled',
  'ExecutablePath',
  // existing fields unchanged
];
```

Add `'ExternalServerEnabled'` to `MANAGED_LLAMA_DEFAULT_BACKFILL_KEYS`.

- [ ] **Step 5: Normalize and expose status-server managed config**

In `src/status-server/config-store.ts`, ensure missing configs backfill the field:

```ts
if (!Object.prototype.hasOwnProperty.call(serverLlama, 'ExternalServerEnabled')) {
  serverLlama.ExternalServerEnabled = false;
}
```

Add the field to `ManagedLlamaConfig`:

```ts
type ManagedLlamaConfig = {
  Model?: string | null;
  ExternalServerEnabled: boolean;
  ExecutablePath: string | null;
  // existing fields unchanged
};
```

Return it from `getManagedLlamaConfig()`:

```ts
return {
  ExternalServerEnabled: serverLlama.ExternalServerEnabled === true,
  ExecutablePath: getNullableTrimmedString(serverLlama.ExecutablePath)
    || (
      legacyExecutablePath
      && !isLegacyManagedStartupScriptPath(legacyExecutablePath)
      && normalizeWindowsPath(legacyExecutablePath) !== normalizeWindowsPath(DEFAULT_LLAMA_STARTUP_SCRIPT)
        ? legacyExecutablePath
        : getNullableTrimmedString(defaults.ExecutablePath)
    ),
  // existing fields unchanged
};
```

Add DB row mapping where `Server.LlamaCpp` is built from the row:

```ts
ExternalServerEnabled: row.server_external_server_enabled === 1,
```

Add a nullable integer column/value in `normalizeConfigToRow()`:

```ts
server_external_server_enabled: serverLlama.ExternalServerEnabled === true ? 1 : 0,
```

Add the column to `readConfigRow()` SELECT and `writeConfigRow()` columns. If the schema migration path is centralized elsewhere, add `server_external_server_enabled INTEGER NOT NULL DEFAULT 0` there instead of relying on a write-time missing column failure.

- [ ] **Step 6: Normalize typed config module**

In `src/config/normalization.ts`, add `'ExternalServerEnabled'` to `MANAGED_LLAMA_DEFAULT_BACKFILL_KEYS` and `MANAGED_LLAMA_PRESET_KEYS`.

In `normalizeConfig()`, add the default before the generic managed field loop or include it in the loop:

```ts
if (!Object.prototype.hasOwnProperty.call(serverLlama, 'ExternalServerEnabled')) {
  serverLlama.ExternalServerEnabled = false;
  changed = true;
}
serverLlama.ExternalServerEnabled = serverLlama.ExternalServerEnabled === true;
```

In `toPersistedConfigObject()`, add:

```ts
ExternalServerEnabled: config.Server?.LlamaCpp?.ExternalServerEnabled === true,
```

- [ ] **Step 7: Run config tests**

Run:

```powershell
npm test -- config
```

Expected: PASS for config tests.

- [ ] **Step 8: Commit**

```powershell
git add src/config/types.ts src/status-server/config-store.ts src/config/normalization.ts tests/config.test.ts
git commit -m "feat: add external llama server config"
```

---

### Task 2: Runtime Managed Llama Lifecycle

**Files:**
- Modify: `src/status-server/managed-llama.ts`
- Test: `tests/managed-llama-blank-startup.test.ts`

- [ ] **Step 1: Write failing lifecycle tests**

Add tests to `tests/managed-llama-blank-startup.test.ts`:

```ts
test('external llama server mode uses reachable base url without executable or model path', async () => {
  await withTempEnv(async (tempRoot) => {
    const remotePort = await getFreePort();
    const remoteServer = require('node:http').createServer((request, response) => {
      if (request.url === '/v1/models') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ data: [{ id: 'remote-model' }] }));
        return;
      }
      response.writeHead(404);
      response.end();
    });
    await new Promise((resolve) => remoteServer.listen(remotePort, '127.0.0.1', resolve));
    try {
      const statusPath = path.join(tempRoot, '.siftkit', 'status', 'inference.txt');
      const configPath = getConfigPath();
      const config = getDefaultConfig();
      config.Server.LlamaCpp.ExternalServerEnabled = true;
      config.Server.LlamaCpp.BaseUrl = `http://127.0.0.1:${remotePort}`;
      config.Server.LlamaCpp.ExecutablePath = null;
      config.Server.LlamaCpp.ModelPath = null;
      config.Runtime.LlamaCpp.BaseUrl = config.Server.LlamaCpp.BaseUrl;
      config.LlamaCpp.BaseUrl = config.Server.LlamaCpp.BaseUrl;
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

      await withRealStatusServer(async ({ configUrl, statusUrl }) => {
        const loadedConfig = await requestJson(configUrl);
        assert.equal(loadedConfig.Server.LlamaCpp.ExternalServerEnabled, true);
        assert.equal(loadedConfig.Server.LlamaCpp.ExecutablePath, null);
        assert.equal(loadedConfig.Server.LlamaCpp.ModelPath, null);
        const status = await requestJson(statusUrl);
        assert.equal(status.running, false);
      }, { statusPath, configPath });
    } finally {
      await new Promise((resolve) => remoteServer.close(resolve));
    }
  });
});

test('external llama server mode fails loud when remote base url is unreachable', async () => {
  await withTempEnv(async (tempRoot) => {
    const statusPath = path.join(tempRoot, '.siftkit', 'status', 'inference.txt');
    const configPath = getConfigPath();
    const unusedPort = await getFreePort();
    const config = getDefaultConfig();
    config.Server.LlamaCpp.ExternalServerEnabled = true;
    config.Server.LlamaCpp.BaseUrl = `http://127.0.0.1:${unusedPort}`;
    config.Server.LlamaCpp.ExecutablePath = null;
    config.Server.LlamaCpp.ModelPath = null;
    config.Runtime.LlamaCpp.BaseUrl = config.Server.LlamaCpp.BaseUrl;
    config.LlamaCpp.BaseUrl = config.Server.LlamaCpp.BaseUrl;
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

    await assert.rejects(
      withRealStatusServer(async ({ configUrl }) => {
        await requestJson(configUrl);
      }, { statusPath, configPath }),
      /External llama\.cpp server is not reachable/u,
    );
  });
});
```

- [ ] **Step 2: Add missing-local-files startup test**

Add this test to `tests/managed-llama-blank-startup.test.ts`:

```ts
test('missing local llama files log degraded startup instead of crashing', async () => {
  await withTempEnv(async (tempRoot) => {
    const statusPath = path.join(tempRoot, '.siftkit', 'status', 'inference.txt');
    const configPath = getConfigPath();
    const unusedPort = await getFreePort();
    const config = getDefaultConfig();
    config.Server.LlamaCpp.ExternalServerEnabled = false;
    config.Server.LlamaCpp.BaseUrl = `http://127.0.0.1:${unusedPort}`;
    config.Server.LlamaCpp.ExecutablePath = null;
    config.Server.LlamaCpp.ModelPath = null;
    config.Runtime.LlamaCpp.BaseUrl = config.Server.LlamaCpp.BaseUrl;
    config.LlamaCpp.BaseUrl = config.Server.LlamaCpp.BaseUrl;
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

    const stderrWrites = [];
    const originalWrite = process.stderr.write;
    process.stderr.write = (chunk, encoding, callback) => {
      stderrWrites.push(String(chunk));
      if (typeof encoding === 'function') {
        encoding();
      } else if (typeof callback === 'function') {
        callback();
      }
      return true;
    };
    try {
      await withRealStatusServer(async ({ configUrl, statusUrl }) => {
        const loadedConfig = await requestJson(configUrl);
        assert.equal(loadedConfig.Server.LlamaCpp.ExternalServerEnabled, false);
        const status = await requestJson(statusUrl);
        assert.equal(status.running, false);
      }, { statusPath, configPath });
    } finally {
      process.stderr.write = originalWrite;
    }

    assert.match(stderrWrites.join(''), /No local llama\.cpp files found/u);
  });
});
```

- [ ] **Step 3: Run tests to verify failure**

Run:

```powershell
npm test -- managed-llama-blank-startup
```

Expected: FAIL because external mode still reaches local spawn validation and missing local files still throw.

- [ ] **Step 4: Add external mode branch in `ensureManagedLlamaReady()`**

In `src/status-server/managed-llama.ts`, after `const managed = getManagedLlamaConfig(config);` and before managed startup/shutdown promise handling:

```ts
if (managed.ExternalServerEnabled) {
  if (await isLlamaServerReachable(config)) {
    ctx.managedLlamaStartupWarning = null;
    ctx.managedLlamaReady = true;
    publishStatus(ctx);
    return config;
  }
  const message = `External llama.cpp server is not reachable at ${baseUrl}.`;
  ctx.managedLlamaStartupWarning = message;
  ctx.managedLlamaReady = false;
  publishStatus(ctx);
  throw new Error(message);
}
```

- [ ] **Step 5: Make missing local files degrade instead of crash**

In `src/status-server/managed-llama.ts`, replace the current throw branches for missing `ExecutablePath` and missing `ModelPath` with one shared degraded path:

```ts
if (!managed.ExecutablePath || !managed.ModelPath) {
  const missingFields = [
    ...(!managed.ExecutablePath ? ['ExecutablePath'] : []),
    ...(!managed.ModelPath ? ['ModelPath'] : []),
  ].join(', ');
  const message = `No local llama.cpp files found; missing config.Server.LlamaCpp.${missingFields}. Configure a local executable/model or enable an external llama.cpp server.`;
  ctx.managedLlamaStartupWarning = message;
  ctx.managedLlamaReady = false;
  publishStatus(ctx);
  process.stderr.write(`[siftKitStatus] ${message}\n`);
  return readConfig(ctx.configPath);
}
```

This branch must run only when `managed.ExternalServerEnabled` is false. External mode should still fail loud when its `BaseUrl` is unreachable.

- [ ] **Step 6: Make shutdown/cleanup ignore external servers**

In `shutdownManagedLlamaIfNeeded()`, after `const managed = getManagedLlamaConfig(config);`:

```ts
if (managed.ExternalServerEnabled) {
  ctx.managedLlamaReady = false;
  ctx.managedLlamaHostProcess = null;
  ctx.managedLlamaLastStartupLogs = null;
  publishStatus(ctx);
  return;
}
```

In `shutdownManagedLlamaForProcessExitSync()`, after `const managed = getManagedLlamaConfig(config);` and before `findListeningProcessIdByPort()`:

```ts
if (managed.ExternalServerEnabled) {
  publishStatus(ctx);
  return;
}
```

In `clearPreexistingManagedLlamaIfNeeded()`, after reading config:

```ts
const managed = getManagedLlamaConfig(config);
if (managed.ExternalServerEnabled) {
  return;
}
if (!hasManagedLlamaLaunchConfig(managed)) {
  return;
}
```

- [ ] **Step 7: Run lifecycle tests**

Run:

```powershell
npm test -- managed-llama-blank-startup
```

Expected: PASS.

- [ ] **Step 8: Commit**

```powershell
git add src/status-server/managed-llama.ts tests/managed-llama-blank-startup.test.ts
git commit -m "feat: degrade when llama backend is unconfigured"
```

---

### Task 3: Local Test Endpoint

**Files:**
- Modify: `src/status-server/routes/core.ts`
- Test: `tests/dashboard-status-server.test.ts`

- [ ] **Step 1: Write failing endpoint tests**

Add tests to `tests/dashboard-status-server.test.ts`:

```ts
test('config llama cpp test endpoint reports reachable external server', async () => {
  await withTempEnv(async () => {
    const remotePort = await getFreePort();
    const remoteServer = require('node:http').createServer((request, response) => {
      if (request.url === '/v1/models') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ data: [{ id: 'remote-model' }] }));
        return;
      }
      response.writeHead(404);
      response.end();
    });
    await new Promise((resolve) => remoteServer.listen(remotePort, '127.0.0.1', resolve));
    try {
      await withRealStatusServer(async ({ baseUrl }) => {
        const result = await requestJson(`${baseUrl}/config/llama-cpp/test`, {
          method: 'POST',
          body: JSON.stringify({ BaseUrl: `http://127.0.0.1:${remotePort}`, HealthcheckTimeoutMs: 1000 }),
        });
        assert.equal(result.ok, true);
        assert.equal(result.statusCode, 200);
      }, { disableManagedLlamaStartup: true });
    } finally {
      await new Promise((resolve) => remoteServer.close(resolve));
    }
  });
});

test('config llama cpp test endpoint reports unreachable external server', async () => {
  await withTempEnv(async () => {
    const unusedPort = await getFreePort();
    await withRealStatusServer(async ({ baseUrl }) => {
      const result = await requestJson(`${baseUrl}/config/llama-cpp/test`, {
        method: 'POST',
        body: JSON.stringify({ BaseUrl: `http://127.0.0.1:${unusedPort}`, HealthcheckTimeoutMs: 100 }),
      });
      assert.equal(result.ok, false);
      assert.equal(result.statusCode, 0);
      assert.match(result.error, /connect|ECONNREFUSED|timed out/i);
    }, { disableManagedLlamaStartup: true });
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```powershell
npm test -- dashboard-status-server
```

Expected: FAIL with missing `/config/llama-cpp/test`.

- [ ] **Step 3: Implement endpoint**

In `src/status-server/routes/core.ts`, import `requestText` if not already imported:

```ts
import { requestText } from '../../lib/http.js';
```

Add route near the existing `/config` routes:

```ts
router.post('/config/llama-cpp/test', async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body as Dict : {};
  const baseUrl = typeof body.BaseUrl === 'string' && body.BaseUrl.trim()
    ? body.BaseUrl.trim().replace(/\/$/u, '')
    : '';
  const timeoutMs = Number.isFinite(Number(body.HealthcheckTimeoutMs)) && Number(body.HealthcheckTimeoutMs) > 0
    ? Math.min(Number(body.HealthcheckTimeoutMs), 30_000)
    : 2_000;
  if (!/^https?:\/\/[^/\s]+/iu.test(baseUrl)) {
    res.status(400).json({ ok: false, statusCode: 0, error: 'BaseUrl must be an http(s) URL.' });
    return;
  }
  try {
    const response = await requestText({ url: `${baseUrl}/v1/models`, timeoutMs });
    res.json({
      ok: response.statusCode > 0 && response.statusCode < 400,
      statusCode: response.statusCode,
      baseUrl,
    });
  } catch (error) {
    res.json({
      ok: false,
      statusCode: 0,
      baseUrl,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
```

Use the local `Dict` type already used in `core.ts`; if the file does not expose `req.body`, follow the existing body parsing convention in that file.

- [ ] **Step 4: Run endpoint tests**

Run:

```powershell
npm test -- dashboard-status-server
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/status-server/routes/core.ts tests/dashboard-status-server.test.ts
git commit -m "feat: add llama server settings test endpoint"
```

---

### Task 4: Dashboard Types and Preset Sync

**Files:**
- Modify: `dashboard/src/types.ts`
- Modify: `dashboard/src/managed-llama-presets.ts`
- Modify: `dashboard/src/settings-runtime.ts`
- Test: `dashboard/tests/tab-components.test.tsx`

- [ ] **Step 1: Write failing dashboard preset sync test**

In `dashboard/tests/tab-components.test.tsx`, add `ExternalServerEnabled: false` to `MANAGED_PRESET`.

Add this test near the model path test:

```ts
test('managed llama external server toggle updates active preset and server config', () => {
  let updatedConfig: DashboardConfig | null = null;
  const section = ManagedLlamaSection({
    dashboardConfig: DASHBOARD_CONFIG,
    selectedManagedLlamaPreset: MANAGED_PRESET,
    settingsActionBusy: false,
    settingsPathPickerBusyTarget: null,
    renderField: (_, label, children) => <div data-label={label}>{children}</div>,
    updateSettingsDraft: () => {},
    updateManagedLlamaDraft: (updater) => {
      const nextConfig = structuredClone(DASHBOARD_CONFIG);
      updateActiveManagedLlamaPreset(nextConfig, updater);
      updatedConfig = nextConfig;
    },
    onAddManagedLlamaPreset: () => {},
    onDeleteManagedLlamaPreset: () => {},
    onPickManagedLlamaPath: async () => {},
    onTestLlamaCppBaseUrl: async () => {},
  });

  const capturedFields: CapturedField[] = [];
  ManagedLlamaSection({
    dashboardConfig: DASHBOARD_CONFIG,
    selectedManagedLlamaPreset: MANAGED_PRESET,
    settingsActionBusy: false,
    settingsPathPickerBusyTarget: null,
    renderField: (_, label, children) => {
      capturedFields.push({ label, children });
      return <div>{children}</div>;
    },
    updateSettingsDraft: () => {},
    updateManagedLlamaDraft: (updater) => {
      const nextConfig = structuredClone(DASHBOARD_CONFIG);
      updateActiveManagedLlamaPreset(nextConfig, updater);
      updatedConfig = nextConfig;
    },
    onAddManagedLlamaPreset: () => {},
    onDeleteManagedLlamaPreset: () => {},
    onPickManagedLlamaPath: async () => {},
    onTestLlamaCppBaseUrl: async () => {},
  });

  const field = capturedFields.find((entry) => entry.label === 'External llama.cpp server');
  assert.ok(field);
  const input = findInputElement(field.children);
  assert.ok(input?.props.onChange);
  input.props.onChange({ target: { checked: true } });
  assert.ok(updatedConfig);
  assert.equal(updatedConfig.Server.LlamaCpp.ExternalServerEnabled, true);
  assert.equal(updatedConfig.Server.LlamaCpp.Presets[0]?.ExternalServerEnabled, true);
  assert.ok(section);
});
```

Update `InputElementProps` to support checkbox events:

```ts
type InputElementProps = {
  children?: ReactNode;
  onChange?: (event: { target: { value: string; checked?: boolean } }) => void;
};
```

- [ ] **Step 2: Run dashboard tests to verify failure**

Run:

```powershell
cd dashboard; npm test -- tab-components
```

Expected: FAIL because the prop and type do not exist yet.

- [ ] **Step 3: Add dashboard type field**

In `dashboard/src/types.ts`, add `ExternalServerEnabled: boolean` to both:

```ts
Server: {
  LlamaCpp: {
    Model: string;
    ExternalServerEnabled: boolean;
    ExecutablePath: string | null;
    // existing fields unchanged
  };
};
```

and:

```ts
export type DashboardManagedLlamaPreset = {
  id: string;
  label: string;
  Model: string;
  ExternalServerEnabled: boolean;
  ExecutablePath: string | null;
  // existing fields unchanged
};
```

- [ ] **Step 4: Sync dashboard preset field**

In `dashboard/src/managed-llama-presets.ts`, add to `buildPresetFromServer()`:

```ts
ExternalServerEnabled: config.Server.LlamaCpp.ExternalServerEnabled,
```

Add to `copyPresetToServer()`:

```ts
config.Server.LlamaCpp.ExternalServerEnabled = preset.ExternalServerEnabled;
```

No change is needed in `dashboard/src/settings-runtime.ts`; `BaseUrl` already syncs to runtime and request clients only need the URL.

- [ ] **Step 5: Run dashboard tests**

Run:

```powershell
cd dashboard; npm test -- tab-components
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add dashboard/src/types.ts dashboard/src/managed-llama-presets.ts dashboard/src/settings-runtime.ts dashboard/tests/tab-components.test.tsx
git commit -m "feat: sync external llama setting in dashboard"
```

---

### Task 5: Dashboard UI and Test Button

**Files:**
- Modify: `dashboard/src/tabs/settings/ManagedLlamaSection.tsx`
- Modify: `dashboard/src/App.tsx`
- Test: `dashboard/tests/tab-components.test.tsx`

- [ ] **Step 1: Write failing render test**

Update `ManagedLlamaSectionProps` usage in `dashboard/tests/tab-components.test.tsx` with `onTestLlamaCppBaseUrl={async () => {}}`.

Add:

```ts
test('managed llama section renders external server controls', () => {
  const capturedFields: string[] = [];
  const markup = renderToStaticMarkup(
    <ManagedLlamaSection
      dashboardConfig={DASHBOARD_CONFIG}
      selectedManagedLlamaPreset={{ ...MANAGED_PRESET, ExternalServerEnabled: true }}
      settingsActionBusy={false}
      settingsPathPickerBusyTarget={null}
      renderField={(_, label, children) => {
        capturedFields.push(label);
        return <div>{children}</div>;
      }}
      updateSettingsDraft={() => {}}
      updateManagedLlamaDraft={() => {}}
      onAddManagedLlamaPreset={() => {}}
      onDeleteManagedLlamaPreset={() => {}}
      onPickManagedLlamaPath={async () => {}}
      onTestLlamaCppBaseUrl={async () => {}}
    />,
  );

  assert.equal(capturedFields.includes('External llama.cpp server'), true);
  assert.match(markup, /Test/);
  assert.doesNotMatch(markup, /Browse/);
});
```

- [ ] **Step 2: Run dashboard tests to verify failure**

Run:

```powershell
cd dashboard; npm test -- tab-components
```

Expected: FAIL because `onTestLlamaCppBaseUrl` and UI controls do not exist.

- [ ] **Step 3: Add prop and UI controls**

In `dashboard/src/tabs/settings/ManagedLlamaSection.tsx`, update props:

```ts
type ManagedLlamaSectionProps = {
  // existing props
  onPickManagedLlamaPath(target: 'ExecutablePath' | 'ModelPath'): Promise<void>;
  onTestLlamaCppBaseUrl(baseUrl: string, timeoutMs: number): Promise<void>;
};
```

Destructure it:

```ts
onPickManagedLlamaPath,
onTestLlamaCppBaseUrl,
}: ManagedLlamaSectionProps) {
```

Add the toggle before `Base URL`:

```tsx
{renderField('model-presets', 'External llama.cpp server', (
  <label className="settings-live-toggle-control">
    <input
      type="checkbox"
      checked={selectedManagedLlamaPreset.ExternalServerEnabled}
      onChange={(event) => updateManagedLlamaDraft((preset) => {
        preset.ExternalServerEnabled = event.target.checked;
      })}
    />
    <span>{selectedManagedLlamaPreset.ExternalServerEnabled ? 'Enabled' : 'Disabled'}</span>
  </label>
))}
```

Replace the `Base URL` field with a test button:

```tsx
{renderField('model-presets', 'Base URL', (
  <div className="settings-live-nav-control">
    <input value={selectedManagedLlamaPreset.BaseUrl} onChange={(event) => updateManagedLlamaDraft((preset) => { preset.BaseUrl = event.target.value; })} />
    <button
      type="button"
      disabled={settingsActionBusy}
      onClick={() => {
        void onTestLlamaCppBaseUrl(
          selectedManagedLlamaPreset.BaseUrl,
          selectedManagedLlamaPreset.HealthcheckTimeoutMs,
        );
      }}
    >
      Test
    </button>
  </div>
))}
```

Hide or disable launcher-only fields when external mode is enabled. Keep `Base URL`, `HealthcheckTimeoutMs`, and `HealthcheckIntervalMs` visible.

For `Executable path`, return `null` when external mode is enabled:

```tsx
{!selectedManagedLlamaPreset.ExternalServerEnabled ? renderField('model-presets', 'Executable path', (
  // existing executable path JSX
), 'managed-llama-top-field') : null}
```

For `Model path (.gguf)`, use the same condition. Leave runtime/model tuning fields visible because remote llama.cpp may still use request-time parameters.

- [ ] **Step 4: Wire App handler**

In `dashboard/src/App.tsx`, find where `ManagedLlamaSection` is rendered and pass:

```tsx
onTestLlamaCppBaseUrl={testLlamaCppBaseUrl}
```

Add explicit handler in `App.tsx` near other settings actions:

```ts
async function testLlamaCppBaseUrl(baseUrl: string, timeoutMs: number): Promise<void> {
  setSettingsActionBusy(true);
  setSettingsError(null);
  try {
    const response = await fetch('/config/llama-cpp/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ BaseUrl: baseUrl, HealthcheckTimeoutMs: timeoutMs }),
    });
    const result = await response.json() as { ok?: boolean; error?: string; statusCode?: number };
    if (!response.ok || result.ok !== true) {
      throw new Error(result.error || `llama.cpp test failed with status ${result.statusCode ?? response.status}`);
    }
    setSettingsSavedAtUtc(new Date().toISOString());
  } catch (error) {
    setSettingsError(error instanceof Error ? error.message : String(error));
  } finally {
    setSettingsActionBusy(false);
  }
}
```

Use the existing settings busy/error setter names in `App.tsx`; if names differ, keep the same behavior with the existing state variables.

- [ ] **Step 5: Run dashboard tests**

Run:

```powershell
cd dashboard; npm test -- tab-components
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add dashboard/src/tabs/settings/ManagedLlamaSection.tsx dashboard/src/App.tsx dashboard/tests/tab-components.test.tsx
git commit -m "feat: add external llama settings controls"
```

---

### Task 6: Integration Validation and Coverage

**Files:**
- No source changes expected unless tests reveal gaps.

- [ ] **Step 1: Run focused backend suites**

Run:

```powershell
npm test -- managed-llama
```

Expected: PASS.

Run:

```powershell
npm test -- dashboard-status-server
```

Expected: PASS.

Run:

```powershell
npm test -- config
```

Expected: PASS.

- [ ] **Step 2: Run dashboard component suite**

Run:

```powershell
cd dashboard; npm test -- tab-components
```

Expected: PASS.

- [ ] **Step 3: Run type/build verification**

Run:

```powershell
npm run build
```

Expected: PASS.

- [ ] **Step 4: Run full test suite**

Run:

```powershell
npm test
```

Expected: PASS. If broad suite times out, rerun the failing named suite directly and record the exact timeout/failure.

- [ ] **Step 5: Commit validation fixes if needed**

Only if validation forced additional source or test changes:

```powershell
git add <changed-files>
git commit -m "test: cover external llama server mode"
```

---

## Design Notes

- Do not add a second URL field. `Server.LlamaCpp.BaseUrl` already defines the llama.cpp API endpoint and already syncs to `Runtime.LlamaCpp.BaseUrl`.
- Do add `ExternalServerEnabled`. Without a boolean, an unreachable local managed server and an intentionally external server are ambiguous.
- Do not remove managed launcher config. A user can toggle external mode off and return to local managed startup.
- Do not change model request queue behavior. The queue still controls local SiftKit admission before requests go to llama.cpp.
- Do not make this a SiftKit reverse proxy. Only the llama.cpp backend URL changes.
- Missing local `ExecutablePath` or `ModelPath` is not fatal during server startup. It is fatal only if a model request later requires a reachable llama.cpp server and none is available.

## Self-Review

- Spec coverage: config flag, external host/port through `BaseUrl`, UI settings, test endpoint, startup bypass, shutdown bypass, and validation are covered.
- Placeholder scan: no placeholder implementation steps remain.
- Type consistency: field name is consistently `ExternalServerEnabled`; endpoint path is consistently `/config/llama-cpp/test`.
