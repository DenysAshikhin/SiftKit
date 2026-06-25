import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

import viteConfig from '../dashboard/vite.config.js';

const ProxyTableSchema = z.record(
  z.string(),
  z.object({ target: z.string(), changeOrigin: z.boolean().optional() }).passthrough(),
);

test('dashboard dev server proxies config requests to the status server', () => {
  const proxy = ProxyTableSchema.parse(viteConfig.server?.proxy);
  assert.deepEqual(proxy['/config'], {
    target: 'http://127.0.0.1:4765',
    changeOrigin: false,
  });
});
