import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, realpathSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';

const AbsolutePathSchema = z.string().min(1).refine(path.isAbsolute, 'Expected an absolute path');
export const UpdateOptionsSchema = z.object({
  mode: z.enum(['update', 'verify']),
  repo: AbsolutePathSchema,
  python: AbsolutePathSchema,
  cuda: AbsolutePathSchema,
  vcvars: AbsolutePathSchema.refine((value) => !/["&|<>^%\r\n]/u.test(value), 'Unsafe command path'),
  scratch: AbsolutePathSchema,
}).strict();

const RuntimeSchema = z.object({
  version: z.string(),
  source: AbsolutePathSchema,
  extension: AbsolutePathSchema,
  torch: z.string(),
  cuda: z.string(),
  available: z.literal(true),
  gpu: z.string(),
  capability: z.tuple([z.number().int(), z.number().int()]),
});
const BuildManifestSchema = RuntimeSchema.extend({
  commit: z.string().regex(/^[a-f0-9]{40}$/u),
  extensionSha256: z.string().regex(/^[a-f0-9]{64}$/u),
});

function run(executable: string, args: string[], cwd: string, env = process.env, log?: string): string {
  const result = spawnSync(executable, args, {
    cwd, env, encoding: 'utf8', windowsHide: true, timeout: 900_000, maxBuffer: 64 * 1024 * 1024,
    windowsVerbatimArguments: path.basename(executable).toLowerCase() === 'cmd.exe',
  });
  if (log) writeFileSync(log, result.stdout + result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${executable} exited ${result.status}: ${log ?? result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

function git(repo: string, args: string[]): string {
  return run('git', ['-C', repo, ...args], repo);
}

function requireCleanSource(repo: string): void {
  if (git(repo, ['status', '--porcelain']).length > 0) {
    throw new Error('EXL3 source is dirty; preserve local changes before updating.');
  }
}

export function validateUpstreamSource(repo: string): string {
  requireCleanSource(repo);
  const commit = git(repo, ['rev-parse', 'HEAD']);
  if (commit !== git(repo, ['rev-parse', 'origin/dev'])) {
    throw new Error('EXL3 source must exactly match upstream origin/dev.');
  }
  return commit;
}

export function fastForwardSource(repo: string): void {
  requireCleanSource(repo);
  if (git(repo, ['merge-base', 'HEAD', 'origin/dev']) !== git(repo, ['rev-parse', 'HEAD'])) {
    throw new Error('EXL3 has diverged or contains local commits; no merge will be attempted.');
  }
  git(repo, ['merge', '--ff-only', 'origin/dev']);
  validateUpstreamSource(repo);
}

function hashFile(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function samePath(left: string, right: string): boolean {
  return realpathSync(left).toLowerCase() === realpathSync(right).toLowerCase();
}

export function readMsvcEnvironment(vcvars: string, cwd: string): NodeJS.ProcessEnv {
  const comspec = AbsolutePathSchema.parse(process.env.ComSpec);
  const environmentText = run(comspec, ['/d', '/s', '/c', `""${path.normalize(vcvars)}" >nul && set"`], cwd);
  const environment: NodeJS.ProcessEnv = { ...process.env };
  for (const line of environmentText.split(/\r?\n/u)) {
    const separator = line.indexOf('=');
    if (separator > 0) environment[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return environment;
}

function probeRuntime(options: z.infer<typeof UpdateOptionsSchema>, env = process.env): z.infer<typeof RuntimeSchema> {
  const output = run(options.python, ['-c', [
    'import json, importlib.metadata as md, torch, exllamav3, exllamav3_ext',
    'torch.ones(1, device="cuda").add_(1); torch.cuda.synchronize()',
    'print(json.dumps(dict(version=md.version("exllamav3"), source=exllamav3.__file__, extension=exllamav3_ext.__file__, torch=torch.__version__, cuda=torch.version.cuda, available=torch.cuda.is_available(), gpu=torch.cuda.get_device_name(0), capability=list(torch.cuda.get_device_capability(0)))))',
  ].join('\n')], options.scratch, env);
  const lastLine = output.split(/\r?\n/u).at(-1);
  if (!lastLine) throw new Error('Runtime probe returned no JSON');
  const runtime = RuntimeSchema.parse(JSON.parse(lastLine));
  if (!samePath(runtime.source, path.join(options.repo, 'exllamav3', '__init__.py'))) {
    throw new Error(`Wrong EXL3 source: ${runtime.source}`);
  }
  return runtime;
}

export function updateExllamav3(options: z.infer<typeof UpdateOptionsSchema>): z.infer<typeof BuildManifestSchema> {
  if (process.platform !== 'win32') throw new Error('This updater requires Windows and MSVC.');
  mkdirSync(options.scratch, { recursive: true });
  const manifestPath = path.resolve(path.dirname(options.python), '..', 'exllamav3-build.json');
  const origin = git(options.repo, ['remote', 'get-url', 'origin']);
  if (origin !== 'https://github.com/turboderp-org/exllamav3.git') {
    throw new Error(`Expected official EXL3 origin, received ${origin}`);
  }
  if (options.mode === 'verify') {
    const manifest = BuildManifestSchema.parse(JSON.parse(readFileSync(manifestPath, 'utf8')));
    const runtime = probeRuntime(options);
    const actual = { ...runtime, commit: validateUpstreamSource(options.repo), extensionSha256: hashFile(runtime.extension) };
    if (JSON.stringify(actual) !== JSON.stringify(manifest)) throw new Error('Installed runtime differs from its verified build manifest.');
    run(options.python, ['-m', 'pip', 'check'], options.scratch);
    return actual;
  }
  requireCleanSource(options.repo);
  git(options.repo, ['fetch', 'origin', 'dev']);
  fastForwardSource(options.repo);
  const commit = validateUpstreamSource(options.repo);
  const buildEnv = readMsvcEnvironment(options.vcvars, options.scratch);
  const torchInfo = z.object({ version: z.string(), cuda: z.string(), arch: z.string() }).parse(JSON.parse(run(
    options.python, ['-c', 'import json, torch; print(json.dumps(dict(version=torch.__version__, cuda=torch.version.cuda, arch=".".join(map(str,torch.cuda.get_device_capability(0))))))'], options.scratch,
  )));
  const nvcc = run(path.join(options.cuda, 'bin', 'nvcc.exe'), ['--version'], options.scratch);
  if (!nvcc.includes(`release ${torchInfo.cuda},`)) throw new Error('CUDA toolkit does not match the installed Torch CUDA version.');
  Object.assign(buildEnv, {
    CUDA_HOME: options.cuda, CUDA_PATH: options.cuda, TORCH_CUDA_ARCH_LIST: torchInfo.arch,
    MAX_JOBS: '4', DISTUTILS_USE_SDK: '1', EXLLAMA_VERBOSE: '1',
    TEMP: options.scratch, TMP: options.scratch,
  });
  // Windows environment keys are case-insensitive; send a single PATH to the child.
  const previousPath = buildEnv.Path ?? buildEnv.PATH ?? '';
  delete buildEnv.Path;
  buildEnv.PATH = `${path.join(options.cuda, 'bin')};${path.dirname(options.python)};${previousPath}`;
  delete buildEnv.EXLLAMA_NOCOMPILE;
  run(options.python, ['-m', 'pip', 'install', '-v', '-e', options.repo, '--no-deps', '--no-build-isolation'],
    options.scratch, buildEnv, path.join(options.scratch, 'exl3-build.log'));
  const extensions = readdirSync(options.repo).filter((name) => /^exllamav3_ext\..*\.pyd$/u.test(name));
  const extension = extensions[0];
  if (extensions.length !== 1 || !extension) throw new Error('Expected exactly one freshly built EXL3 extension.');
  const builtExtension = path.join(options.repo, extension);
  const sitePackages = AbsolutePathSchema.parse(run(options.python, ['-c', 'import sysconfig; print(sysconfig.get_path("platlib"))'], options.scratch));
  const installedExtension = path.join(sitePackages, extension);
  copyFileSync(builtExtension, installedExtension);
  if (hashFile(builtExtension) !== hashFile(installedExtension)) throw new Error('Installed extension differs from the build.');
  unlinkSync(builtExtension);
  const runtime = probeRuntime(options, buildEnv);
  if (runtime.torch !== torchInfo.version || runtime.cuda !== torchInfo.cuda || !samePath(runtime.extension, installedExtension)) {
    throw new Error('Build replaced the Torch stack or loaded the wrong extension.');
  }
  const versionSource = readFileSync(path.join(options.repo, 'exllamav3', 'version.py'), 'utf8');
  if (!versionSource.includes(`__version__ = "${runtime.version}"`)) throw new Error('Installed and source EXL3 versions differ.');
  run(options.python, ['-m', 'pip', 'check'], options.scratch);
  if (validateUpstreamSource(options.repo) !== commit) throw new Error('EXL3 source changed during build.');
  const manifest = BuildManifestSchema.parse({ ...runtime, commit, extensionSha256: hashFile(runtime.extension) });
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: {
    mode: { type: 'string', default: 'update' }, repo: { type: 'string' }, python: { type: 'string' },
    cuda: { type: 'string' }, vcvars: { type: 'string' }, scratch: { type: 'string' },
  } });
  console.log(JSON.stringify(updateExllamav3(UpdateOptionsSchema.parse(values)), null, 2));
}
