import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';

import { HeadlessChrome, bundleBrowserPage, bundleResponse } from '../helpers/browser-page.ts';
import { LayoutReportSchema } from '../../dashboard/tests/orchestrator-layout-content.ts';

function serve(bundles: ReadonlyMap<string, Map<string, string>>): Promise<http.Server> {
  const server = http.createServer((request, response) => {
    const route = bundleResponse(bundles, new URL(request.url ?? '/', 'http://localhost').pathname);
    if (route === null) response.writeHead(404).end();
    else response.writeHead(200, { 'Content-Type': route.contentType }).end(route.body);
  });
  return new Promise((resolve) => { server.listen(0, '127.0.0.1', () => resolve(server)); });
}

test('the panes sit side by side, keep their size, scroll alone, and keep the run-wide bar in view', { timeout: 120_000 }, async () => {
  const server = await serve(new Map([['page', await bundleBrowserPage(path.join('dashboard', 'tests', 'orchestrator-layout-page.tsx'))]]));
  const chrome = await HeadlessChrome.launch();
  try {
    const address = server.address();
    if (address === null || typeof address === 'string') assert.fail('The page server has no TCP port.');
    const page = await chrome.open(`http://127.0.0.1:${String(address.port)}/page/`, 'runLayout');
    const { wide, grown, scrolledAway, expanded, fitted, narrow } = await page.evaluate('window.runLayout()', true, LayoutReportSchema);
    assert.deepEqual([wide.sideBySide, wide.panelFillsColumn, wide.runLineVisible], [true, true, true]);
    assert.ok(wide.conversation.scrollHeight > wide.conversation.height, 'the conversation scrolls inside its pane');
    assert.ok(wide.tasks.scrollHeight > wide.tasks.height, 'and so do the tasks');
    assert.ok(wide.tasks.scrollTop > 0, 'the tasks pane follows the running task');
    assert.equal(wide.conversation.scrollTop, wide.conversation.scrollHeight - wide.conversation.height, 'the conversation follows its end');
    assert.equal(grown.conversation.height, wide.conversation.height, '200 more turns leave the pane its size');
    assert.equal(grown.runLineVisible, true);
    assert.deepEqual(scrolledAway, { conversationTop: 0, tasksMoved: false }, 'a pane the user scrolled stays put, and the other does not move');
    assert.equal(expanded.runLineVisible, true);
    assert.ok(expanded.listHeight <= 230, String(expanded.listHeight));
    assert.equal(expanded.listAtEnd, true, 'the expanded list opens at the newest line');
    for (const [size, fit] of Object.entries(fitted)) {
      assert.equal(fit.fits, true, `${size}: the whole panel fits the chat's message pane, ${JSON.stringify(fit)}`);
      assert.ok(fit.paneHeight >= 260, `${size}: ${String(fit.paneHeight)}`);
    }
    assert.ok(fitted.middle.panelHeight > fitted.short.panelHeight, 'and uses the room it has');
    assert.ok(fitted.tall.panelHeight <= 1000, 'up to a limit');
    assert.equal(narrow.stacked, true);
  } finally {
    await chrome.close();
    server.close();
  }
});
