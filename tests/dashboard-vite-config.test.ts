import test from 'node:test';
import assert from 'node:assert/strict';

import viteConfig from '../dashboard/vite.config.ts';

type ProxyEntry = {
  target: string;
  changeOrigin?: boolean;
};

test('dashboard dev server proxies config requests to the status server', () => {
  const proxy = viteConfig.server?.proxy as Record<string, ProxyEntry> | undefined;
  assert.ok(proxy);
  assert.deepEqual(proxy['/config'], {
    target: 'http://127.0.0.1:4765',
    changeOrigin: false,
  });
});
