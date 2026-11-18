import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { z } from 'zod';
import { HeadlessChrome } from '../helpers/browser-page.ts';

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Real case: Chrome 157 relaunches itself, so the spawned process exits at once and the browser it starts outlives
// it. Waiting on the spawned process's stderr hung every browser test, and closing it leaked 60 browsers.
test('a headless browser connects, runs a page, and leaves no process or profile behind once closed', async () => {
  const chrome = await HeadlessChrome.launch();
  const { browserPid, userDataDir } = chrome;
  try {
    assert.ok(isAlive(browserPid), 'the browser the session drives is running');
    const page = await chrome.open('data:text/html,<script>window.ready = () => 6 * 7</script>', 'ready');
    assert.equal(await page.evaluate('window.ready()', false, z.number()), 42);
  } finally {
    await chrome.close();
  }
  assert.equal(isAlive(browserPid), false, 'the browser exited');
  assert.equal(fs.existsSync(userDataDir), false, 'its profile directory is removed');
});
