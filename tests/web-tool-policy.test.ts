import test from 'node:test';
import assert from 'node:assert/strict';

import { hasUsableWebSearchProvider } from '../src/web-search/web-search-provider.js';
import { applyWebToolPolicy, resolveWebToolPolicy } from '../src/web-search/tool-policy.js';
import { EXPOSED_REPO_TOOL_NAMES } from '../src/planner-protocol/repo-search.js';
import { resolveRepoSearchPlannerToolDefinitions } from '../src/repo-search/planner-protocol.js';
import { buildWebSearchConfig } from './helpers/mock-config.js';

test('hasUsableWebSearchProvider is false when every provider is disabled', () => {
  assert.equal(hasUsableWebSearchProvider(buildWebSearchConfig()), false);
});

test('hasUsableWebSearchProvider is false when a provider is enabled without an api key', () => {
  const config = buildWebSearchConfig({
    Providers: {
      tavily: { Enabled: true, ApiKey: '   ' },
      firecrawl: { Enabled: false, ApiKey: '' },
    },
  });
  assert.equal(hasUsableWebSearchProvider(config), false);
});

test('hasUsableWebSearchProvider is true when one provider is enabled with a key', () => {
  const config = buildWebSearchConfig({
    Providers: {
      tavily: { Enabled: true, ApiKey: 'tvly-key' },
      firecrawl: { Enabled: false, ApiKey: '' },
    },
  });
  assert.equal(hasUsableWebSearchProvider(config), true);
});

test('hasUsableWebSearchProvider ignores providers missing from ProviderOrder', () => {
  const config = buildWebSearchConfig({
    ProviderOrder: ['firecrawl'],
    Providers: {
      tavily: { Enabled: true, ApiKey: 'tvly-key' },
      firecrawl: { Enabled: false, ApiKey: '' },
    },
  });
  assert.equal(hasUsableWebSearchProvider(config), false);
});

test('resolveWebToolPolicy denies both web tools when EnabledDefault is false', () => {
  const policy = resolveWebToolPolicy(buildWebSearchConfig({ EnabledDefault: false }), undefined);
  assert.deepEqual(policy, { webSearch: false, webFetch: false });
});

test('resolveWebToolPolicy denies web_search when enabled but no provider is usable', () => {
  const policy = resolveWebToolPolicy(buildWebSearchConfig({ EnabledDefault: true }), undefined);
  assert.deepEqual(policy, { webSearch: false, webFetch: true });
});

test('resolveWebToolPolicy allows both when enabled with a usable provider', () => {
  const config = buildWebSearchConfig({
    EnabledDefault: true,
    Providers: {
      tavily: { Enabled: true, ApiKey: 'tvly-key' },
      firecrawl: { Enabled: false, ApiKey: '' },
    },
  });
  assert.deepEqual(resolveWebToolPolicy(config, undefined), { webSearch: true, webFetch: true });
});

test('an explicit false overrides EnabledDefault true', () => {
  const config = buildWebSearchConfig({
    EnabledDefault: true,
    Providers: {
      tavily: { Enabled: true, ApiKey: 'tvly-key' },
      firecrawl: { Enabled: false, ApiKey: '' },
    },
  });
  assert.deepEqual(resolveWebToolPolicy(config, false), { webSearch: false, webFetch: false });
});

test('an explicit true overrides EnabledDefault false but still needs a provider for web_search', () => {
  const policy = resolveWebToolPolicy(buildWebSearchConfig({ EnabledDefault: false }), true);
  assert.deepEqual(policy, { webSearch: false, webFetch: true });
});

test('applyWebToolPolicy strips only the denied web tools and preserves order', () => {
  const names = ['read', 'grep', 'web_search', 'find', 'web_fetch', 'git'];
  assert.deepEqual(
    applyWebToolPolicy(names, { webSearch: false, webFetch: false }),
    ['read', 'grep', 'find', 'git'],
  );
  assert.deepEqual(
    applyWebToolPolicy(names, { webSearch: false, webFetch: true }),
    ['read', 'grep', 'find', 'web_fetch', 'git'],
  );
  assert.deepEqual(
    applyWebToolPolicy(names, { webSearch: true, webFetch: true }),
    names,
  );
});

test('the exposed repo tool surface still lists both web tools before any policy runs', () => {
  assert.equal(EXPOSED_REPO_TOOL_NAMES.includes('web_search'), true);
  assert.equal(EXPOSED_REPO_TOOL_NAMES.includes('web_fetch'), true);
});

test('a disabled web config resolves the default surface without either web tool', () => {
  const policy = resolveWebToolPolicy(buildWebSearchConfig({ EnabledDefault: false }), undefined);
  const allowed = applyWebToolPolicy([...EXPOSED_REPO_TOOL_NAMES], policy);
  const names = resolveRepoSearchPlannerToolDefinitions(allowed).map((d) => d.function.name);
  assert.deepEqual(names, ['read', 'grep', 'find', 'ls', 'git']);
});

test('an enabled web config without providers keeps web_fetch and drops web_search', () => {
  const policy = resolveWebToolPolicy(buildWebSearchConfig({ EnabledDefault: true }), undefined);
  const allowed = applyWebToolPolicy([...EXPOSED_REPO_TOOL_NAMES], policy);
  const names = resolveRepoSearchPlannerToolDefinitions(allowed).map((d) => d.function.name);
  assert.deepEqual(names, ['read', 'grep', 'find', 'ls', 'git', 'web_fetch']);
});
