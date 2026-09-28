import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { build } from 'esbuild';
import { z } from 'zod';
import { JsonValueSchema, type JsonObject, type JsonValue } from '../../src/lib/json-types.js';
import { parseJsonText } from '../../src/lib/json.js';

const CHROME_PATHS = [
  process.env.SIFTKIT_TEST_CHROME,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];
// Glic (Gemini in Chrome) lays out the whole page once after load; that cost is the browser's, not the page's.
const CHROME_FLAGS = ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-features=Glic',
  '--remote-debugging-port=0', '--window-size=1000,1400', 'about:blank'];
const PAGE_READY_TRIES = 200;
const PAGE_READY_POLL_MS = 50;

function findChrome(): string {
  const found = CHROME_PATHS.find((candidate) => candidate !== undefined && fs.existsSync(candidate));
  if (found === undefined) throw new Error('Browser tests need Chrome: install it or set SIFTKIT_TEST_CHROME.');
  return found;
}

/** The markup that loads a bundled page's stylesheet and script from beside it. */
const PAGE_HTML = '<!doctype html><link rel="stylesheet" href="page.css"><div id="root"></div><script type="module" src="page.js"></script>';

/** A dashboard test page's script and stylesheet bundled in memory, keyed `page.js` and `page.css`. */
export async function bundleBrowserPage(entry: string, nodeEnv: 'production' | 'development' = 'production'): Promise<Map<string, string>> {
  const result = await build({
    entryPoints: { page: path.join(process.cwd(), entry) },
    outdir: 'out', write: false, bundle: true, format: 'esm', platform: 'browser', jsx: 'automatic', logLevel: 'silent',
    define: { 'process.env.NODE_ENV': JSON.stringify(nodeEnv) },
  });
  return new Map(result.outputFiles.map((file) => [path.basename(file.path), file.text]));
}

const CONTENT_TYPES = new Map([['', 'text/html'], ['page.js', 'text/javascript'], ['page.css', 'text/css']]);

/** What `/<bundle>/<file>` serves from bundles keyed by name, or null when no such bundle or file exists. */
export function bundleResponse(bundles: ReadonlyMap<string, Map<string, string>>, pathname: string): { contentType: string; body: string } | null {
  const [, name = '', file = '', ...rest] = pathname.split('/');
  const files = bundles.get(name);
  const contentType = CONTENT_TYPES.get(file);
  const body = file === '' ? PAGE_HTML : files?.get(file);
  return files === undefined || contentType === undefined || body === undefined || rest.length > 0 ? null : { contentType, body };
}

const CdpMessageSchema = z.object({
  id: z.number().optional(), result: JsonValueSchema.optional(), error: z.object({ message: z.string() }).optional(),
});
const EvaluateSchema = z.object({
  result: z.object({ value: JsonValueSchema.optional() }),
  exceptionDetails: z.object({ text: z.string(), exception: z.object({ description: z.string().optional() }).optional() }).optional(),
});

/** One DevTools connection to the browser; page commands carry the flattened session they target. */
class DevTools {
  private nextId = 0;
  private readonly pending = new Map<number, { resolve(result: JsonValue): void; reject(error: Error): void }>();

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') throw new Error('DevTools sent a binary message.');
      const message = parseJsonText(event.data, CdpMessageSchema);
      const waiter = message.id === undefined ? undefined : this.pending.get(message.id);
      if (message.id === undefined || waiter === undefined) return;
      this.pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result ?? null);
    });
  }

  static async connect(url: string): Promise<DevTools> {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', () => reject(new Error('DevTools connection failed.')), { once: true });
    });
    return new DevTools(socket);
  }

  async send<T>(method: string, params: JsonObject, schema: z.ZodType<T>, sessionId?: string): Promise<T> {
    this.nextId += 1;
    const id = this.nextId;
    const result = new Promise<JsonValue>((resolve, reject) => { this.pending.set(id, { resolve, reject }); });
    this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return schema.parse(await result);
  }

  /** The browser may exit before it replies, so closing waits on the process, not the socket. */
  closeBrowser(): void {
    this.socket.send(JSON.stringify({ id: 0, method: 'Browser.close' }));
  }
}

/** One open tab, driven through its DevTools session. */
export class BrowserPage {
  constructor(private readonly devTools: DevTools, private readonly sessionId: string, private readonly targetId: string) {}

  send<T>(method: string, params: JsonObject, schema: z.ZodType<T>): Promise<T> {
    return this.devTools.send(method, params, schema, this.sessionId);
  }

  /** The expression's value parsed by `schema`; a thrown page error fails here with the page's own message. */
  async evaluate<T>(expression: string, awaitPromise: boolean, schema: z.ZodType<T>): Promise<T> {
    const reply = await this.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true }, EvaluateSchema);
    if (reply.exceptionDetails) throw new Error(reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text);
    return schema.parse(reply.result.value);
  }

  async close(): Promise<void> {
    await this.devTools.send('Target.closeTarget', { targetId: this.targetId }, z.object({ success: z.boolean().optional() }));
  }
}

/** Headless Chrome with one flag list for every browser test; its default headless profile is temporary and removed on close. */
export class HeadlessChrome {
  private constructor(readonly devTools: DevTools, private readonly exited: Promise<void>) {}

  static async launch(): Promise<HeadlessChrome> {
    const chrome = spawn(findChrome(), CHROME_FLAGS);
    const exited = new Promise<void>((resolve) => { chrome.once('exit', () => resolve()); });
    const url = await new Promise<string>((resolve, reject) => {
      let stderr = '';
      chrome.once('error', reject);
      chrome.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
        const match = /DevTools listening on (ws:\S+)/u.exec(stderr)?.[1];
        if (match !== undefined) resolve(match);
      });
    });
    return new HeadlessChrome(await DevTools.connect(url), exited);
  }

  /** Opens `url` and waits until the page defines `window[entry]` as a function. */
  async open(url: string, entry: string): Promise<BrowserPage> {
    const { targetId } = await this.devTools.send('Target.createTarget', { url }, z.object({ targetId: z.string() }));
    const { sessionId } = await this.devTools.send('Target.attachToTarget', { targetId, flatten: true }, z.object({ sessionId: z.string() }));
    const page = new BrowserPage(this.devTools, sessionId, targetId);
    for (let tries = 0; await page.evaluate(`typeof window.${entry}`, false, z.string()) !== 'function'; tries += 1) {
      if (tries >= PAGE_READY_TRIES) throw new Error(`The page at ${url} never defined window.${entry}.`);
      await sleep(PAGE_READY_POLL_MS);
    }
    return page;
  }

  async close(): Promise<void> {
    this.devTools.closeBrowser();
    await this.exited;
  }
}
