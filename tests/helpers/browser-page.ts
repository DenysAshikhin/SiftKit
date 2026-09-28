import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';

const CHROME_PATHS = [
  process.env.SIFTKIT_TEST_CHROME,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

export function findChrome(): string {
  const found = CHROME_PATHS.find((candidate) => candidate !== undefined && fs.existsSync(candidate));
  if (found === undefined) throw new Error('Browser tests need Chrome: install it or set SIFTKIT_TEST_CHROME.');
  return found;
}

/** The markup that loads a bundled page's stylesheet and script from beside it. */
export const PAGE_HTML = '<!doctype html><link rel="stylesheet" href="page.css"><div id="root"></div><script type="module" src="page.js"></script>';

/** A dashboard test page's script and stylesheet bundled in memory, keyed `page.js` and `page.css`. */
export async function bundleBrowserPage(entry: string, nodeEnv: 'production' | 'development' = 'production'): Promise<Map<string, string>> {
  const result = await build({
    entryPoints: { page: path.join(process.cwd(), entry) },
    outdir: 'out', write: false, bundle: true, format: 'esm', platform: 'browser', jsx: 'automatic', logLevel: 'silent',
    define: { 'process.env.NODE_ENV': JSON.stringify(nodeEnv) },
  });
  return new Map(result.outputFiles.map((file) => [path.basename(file.path), file.text]));
}
