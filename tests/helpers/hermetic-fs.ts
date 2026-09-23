import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Volume } from 'memfs';

/**
 * Hermetic test files keep every file under the OS temp directory in memory: `node:fs` and
 * `node:fs/promises` route those paths to a memfs volume, while reads anywhere else still reach the
 * real disk (sources, checked-in fixtures). A write anywhere else fails the test file, so a test
 * cannot touch the repository or the user's profile. Loaded only by live-instance-guard.ts.
 */
const REAL_ROOT = path.resolve(os.tmpdir());
const VIRTUAL_ROOT = '/tmp';
const VIRTUAL_FD_FLOOR = 0x40000000;
const CASE_INSENSITIVE = process.platform === 'win32';

const volume = new Volume();
volume.mkdirSync(VIRTUAL_ROOT, { recursive: true });
const writeViolations: string[] = [];

type Variant = 'sync' | 'callback' | 'promise';
type Arg = object | string | number | boolean | null | undefined;

const PATH_READS = ['access', 'exists', 'lstat', 'stat', 'statfs', 'readFile', 'readdir', 'readlink', 'realpath', 'opendir', 'createReadStream', 'watch'] as const;
const PATH_WRITES = ['appendFile', 'chmod', 'chown', 'lchown', 'lutimes', 'mkdir', 'mkdtemp', 'rm', 'rmdir', 'truncate', 'unlink', 'utimes', 'writeFile', 'createWriteStream'] as const;
const TWO_PATHS = ['rename', 'copyFile', 'cp', 'link'] as const;
const FD_CALLS = ['close', 'fstat', 'fsync', 'fdatasync', 'ftruncate', 'futimes', 'fchmod', 'fchown', 'read', 'readv', 'write', 'writev'] as const;
const PATH_RESULTS = new Set(['mkdtemp', 'realpath', 'mkdir']);

function normalizeCase(value: string): string {
  return CASE_INSENSITIVE ? value.toLowerCase() : value;
}

/** The absolute form of a path argument, or null when the argument is not a path. */
function toAbsolute(value: Arg): string | null {
  let raw: string;
  if (typeof value === 'string') raw = value;
  else if (Buffer.isBuffer(value)) raw = value.toString();
  else if (value instanceof URL) raw = fileURLToPath(value);
  else return null;
  // Long-path prefixed forms name the same file; routing only needs the ordinary form.
  return path.resolve(raw.startsWith('\\\\?\\') ? raw.slice(4) : raw);
}

// The file node is running already exists on disk, even when it sits under the temp directory.
const ENTRYPOINT = process.argv[1] === undefined ? null : normalizeCase(path.resolve(process.argv[1]));

function isVirtual(absolutePath: string): boolean {
  const candidate = normalizeCase(absolutePath);
  const root = normalizeCase(REAL_ROOT);
  return candidate !== ENTRYPOINT && (candidate === root || candidate.startsWith(root + path.sep));
}

function toVirtual(absolutePath: string): string {
  return VIRTUAL_ROOT + absolutePath.slice(REAL_ROOT.length).split(path.sep).join('/');
}

function toReal(virtualPath: string): string {
  if (virtualPath !== VIRTUAL_ROOT && !virtualPath.startsWith(`${VIRTUAL_ROOT}/`)) return virtualPath;
  return REAL_ROOT + virtualPath.slice(VIRTUAL_ROOT.length).split('/').join(path.sep);
}

function failWrite(operation: string, target: string): never {
  const violation = `${operation}(${target})`;
  if (!writeViolations.includes(violation)) writeViolations.push(violation);
  throw new Error(`${violation} writes outside the OS temp directory; the default suite keeps its files in memory.`);
}

/** Rewrites virtual paths inside a memfs error so callers see the paths they passed. */
function translateError(error: Error): Error {
  error.message = error.message.replace(/\/tmp(?:\/[^'",\s)]*)?/gu, (match) => toReal(match));
  for (const key of ['path', 'dest'] as const) {
    const value = Reflect.get(error, key);
    if (typeof value === 'string') Reflect.set(error, key, toReal(value));
  }
  return error;
}

function translateResult(name: string, result: Arg): Arg {
  if (typeof result === 'string' && PATH_RESULTS.has(name)) return toReal(result);
  if (Array.isArray(result) && name === 'readdir') {
    for (const entry of result) {
      if (typeof entry !== 'object' || entry === null) continue;
      for (const key of ['path', 'parentPath'] as const) {
        const value = Reflect.get(entry, key);
        if (typeof value === 'string') Object.defineProperty(entry, key, { value: toReal(value), configurable: true, writable: true });
      }
    }
  }
  return result;
}

function isWriteOpen(flags: string | number | undefined): boolean {
  if (flags === undefined) return false;
  if (typeof flags === 'number') return (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT)) !== 0;
  return /[wa+]/u.test(flags);
}

function volumeFunction(variant: Variant, name: string): { target: object; fn: Function } {
  const target = variant === 'promise' ? volume.promises : volume;
  const fn = Reflect.get(target, variant === 'sync' ? `${name}Sync` : name);
  if (typeof fn !== 'function') throw new Error(`The in-memory filesystem has no ${variant} ${name}.`);
  return { target, fn };
}

function lastFunctionIndex(args: Arg[]): number {
  for (let index = args.length - 1; index >= 0; index -= 1) if (typeof args[index] === 'function') return index;
  return -1;
}

function nextTurn(): Promise<void> {
  return new Promise<void>((resolve) => { setImmediate(resolve); });
}

/** memfs FileHandle methods settle on microtasks; real ones resolve on a later event-loop turn. */
function yieldingFileHandle(handle: object): object {
  return new Proxy(handle, {
    get(target, key) {
      const value = Reflect.get(target, key);
      if (typeof value !== 'function') return value;
      return (...args: Arg[]) => nextTurn().then(() => Reflect.apply(value, target, args));
    },
  });
}

/** Runs the memfs counterpart, translating results and errors back to real paths. */
function callVolume(variant: Variant, name: string, args: Arg[]) {
  const { target, fn } = volumeFunction(variant, name);
  if (variant === 'callback') {
    const callbackIndex = lastFunctionIndex(args);
    const callback = args[callbackIndex];
    if (typeof callback === 'function') {
      args[callbackIndex] = (error: Error | null, ...results: Array<object | string | undefined>) => {
        if (error) Reflect.apply(callback, undefined, [translateError(error)]);
        else Reflect.apply(callback, undefined, [null, ...results.map((result) => translateResult(name, result))]);
      };
    }
    return Reflect.apply(fn, target, args);
  }
  if (variant === 'promise') {
    // Real async I/O resolves on a later turn of the event loop; code that yields to timers relies on it.
    return nextTurn().then(() => Reflect.apply(fn, target, args)).then(
      (result) => (name === 'open' && typeof result === 'object' && result !== null ? yieldingFileHandle(result) : translateResult(name, result)),
      (error: Error) => { throw translateError(error); },
    );
  }
  try {
    return translateResult(name, Reflect.apply(fn, target, args));
  } catch (error) {
    throw error instanceof Error ? translateError(error) : error;
  }
}

/** Copies a real file or directory tree into the volume: fixtures read from disk into a temp dir. */
function copyRealIntoVolume(source: string, destination: string): void {
  const stats = fs.statSync(source);
  if (stats.isDirectory()) {
    volume.mkdirSync(destination, { recursive: true });
    for (const entry of fs.readdirSync(source)) copyRealIntoVolume(path.join(source, entry), `${destination}/${entry}`);
    return;
  }
  volume.mkdirSync(path.posix.dirname(destination), { recursive: true });
  volume.writeFileSync(destination, fs.readFileSync(source));
}

function settle(variant: Variant, args: Arg[], run: () => void) {
  if (variant === 'sync') return run();
  if (variant === 'promise') return new Promise<void>((resolve) => { run(); resolve(); });
  const callback = args[lastFunctionIndex(args)];
  try {
    run();
    if (typeof callback === 'function') process.nextTick(() => Reflect.apply(callback, undefined, [null]));
  } catch (error) {
    if (typeof callback === 'function') process.nextTick(() => Reflect.apply(callback, undefined, [error]));
  }
  return undefined;
}

function isVirtualFd(value: Arg): boolean {
  return typeof value === 'number' && value >= VIRTUAL_FD_FLOOR;
}

function routePathCall(variant: Variant, name: string, write: boolean, target: Function, thisArg: object, args: Arg[]) {
  // readFile, writeFile and appendFile also take an open descriptor in place of a path.
  if (isVirtualFd(args[0])) return callVolume(variant, name, args);
  const absolute = toAbsolute(args[0]);
  if (absolute === null) return Reflect.apply(target, thisArg, args);
  if (!isVirtual(absolute)) {
    const writes = write || (name === 'open' && isWriteOpen(typeof args[1] === 'string' || typeof args[1] === 'number' ? args[1] : undefined));
    if (writes) failWrite(name, absolute);
    return Reflect.apply(target, thisArg, args);
  }
  return callVolume(variant, name, [toVirtual(absolute), ...args.slice(1)]);
}

function routeTwoPathCall(variant: Variant, name: string, target: Function, thisArg: object, args: Arg[]) {
  const source = toAbsolute(args[0]);
  const destination = toAbsolute(args[1]);
  if (source === null || destination === null) return Reflect.apply(target, thisArg, args);
  if (!isVirtual(destination)) failWrite(name, destination);
  if (isVirtual(source)) return callVolume(variant, name, [toVirtual(source), toVirtual(destination), ...args.slice(2)]);
  if (name !== 'copyFile' && name !== 'cp') failWrite(name, destination);
  return settle(variant, args, () => copyRealIntoVolume(source, toVirtual(destination)));
}

function routeFdCall(variant: Variant, name: string, target: Function, thisArg: object, args: Arg[]) {
  if (isVirtualFd(args[0])) return callVolume(variant, name, args);
  return Reflect.apply(target, thisArg, args);
}

/** symlink(target, path): the link itself decides the filesystem; an absolute target is mapped along. */
function routeSymlinkCall(variant: Variant, target: Function, thisArg: object, args: Arg[]) {
  const link = toAbsolute(args[1]);
  if (link === null) return Reflect.apply(target, thisArg, args);
  if (!isVirtual(link)) failWrite('symlink', link);
  const linkTarget = typeof args[0] === 'string' && path.isAbsolute(args[0]) ? toAbsolute(args[0]) : null;
  const mappedTarget = linkTarget !== null && isVirtual(linkTarget) ? toVirtual(linkTarget) : args[0];
  return callVolume(variant, 'symlink', [mappedTarget, toVirtual(link), ...args.slice(2)]);
}

function install(owner: object, key: string, variant: Variant, name: string, route: 'read' | 'write' | 'two' | 'fd' | 'open' | 'symlink'): void {
  const original = Reflect.get(owner, key);
  if (typeof original !== 'function') return;
  const routed = new Proxy(original, {
    apply(target, thisArg, argArray) {
      if (route === 'two') return routeTwoPathCall(variant, name, target, thisArg, argArray);
      if (route === 'fd') return routeFdCall(variant, name, target, thisArg, argArray);
      if (route === 'symlink') return routeSymlinkCall(variant, target, thisArg, argArray);
      return routePathCall(variant, name, route === 'write', target, thisArg, argArray);
    },
  });
  Object.defineProperty(owner, key, { value: routed, configurable: true, writable: true, enumerable: true });
}

function installEverywhere(name: string, route: 'read' | 'write' | 'two' | 'fd' | 'open' | 'symlink'): void {
  install(fs, `${name}Sync`, 'sync', name, route);
  install(fs, name, 'callback', name, route);
  if (route !== 'fd') install(fs.promises, name, 'promise', name, route);
}

for (const name of PATH_READS) installEverywhere(name, 'read');
for (const name of PATH_WRITES) installEverywhere(name, 'write');
for (const name of TWO_PATHS) installEverywhere(name, 'two');
for (const name of FD_CALLS) installEverywhere(name, 'fd');
installEverywhere('open', 'open');
installEverywhere('symlink', 'symlink');
// `native` hangs off the realpath functions themselves.
install(fs.realpathSync, 'native', 'sync', 'realpath', 'read');
install(fs.realpath, 'native', 'callback', 'realpath', 'read');

// A test that chdirs into a temp repo keeps working: the cwd may be a directory that exists only in memory.
let virtualCwd: string | null = null;
const realCwd = process.cwd.bind(process);
const realChdir = process.chdir.bind(process);
process.cwd = () => virtualCwd ?? realCwd();
process.chdir = (directory: string) => {
  const absolute = path.resolve(directory);
  if (!isVirtual(absolute)) {
    realChdir(absolute);
    virtualCwd = null;
    return;
  }
  if (!volume.statSync(toVirtual(absolute)).isDirectory()) throw new Error(`ENOTDIR: not a directory, chdir '${absolute}'`);
  virtualCwd = absolute;
};

syncBuiltinESMExports();

process.on('exit', () => {
  if (writeViolations.length === 0) return;
  process.exitCode = 1;
  process.stderr.write(
    `\nFILE WRITTEN OUTSIDE THE TEMP DIRECTORY by ${process.argv[1]}:\n`
    + writeViolations.map((violation) => `  - ${violation}\n`).join(''),
  );
});
