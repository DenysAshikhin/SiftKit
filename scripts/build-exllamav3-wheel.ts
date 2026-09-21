import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { availableParallelism } from 'node:os';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';

const AbsolutePathSchema = z.string().min(1).refine(path.isAbsolute, 'Expected an absolute path');
const ToolchainSchema = z.object({
  python: AbsolutePathSchema,
  cuda: AbsolutePathSchema,
  vcvars: AbsolutePathSchema.refine((value) => !/["&|<>^%\r\n]/u.test(value), 'Unsafe command path'),
  scratch: AbsolutePathSchema,
});

// Builds and installs a wheel from clean source containing origin/dev, including pending PR commits.
export const WheelOptionsSchema = ToolchainSchema.extend({
  repo: AbsolutePathSchema,
  packages: AbsolutePathSchema,
  jobs: z.coerce.number().int().positive().optional(),
}).strict();

const CommitSchema = z.string().regex(/^[a-f0-9]{40}$/u);
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
const WheelManifestSchema = RuntimeSchema.extend({
  commit: CommitSchema,
  upstream: CommitSchema,
  localCommits: z.array(z.string()),
  wheel: z.string(),
  wheelSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  jobs: z.number().int().positive(),
});
const TorchInfoSchema = z.object({ version: z.string(), cuda: z.string(), arch: z.string() });

function run(executable: string, args: string[], cwd: string, env = process.env, log?: string) {
  const result = spawnSync(executable, args, {
    cwd, env, encoding: 'utf8', windowsHide: true, timeout: 900_000, maxBuffer: 64 * 1024 * 1024,
    windowsVerbatimArguments: path.basename(executable).toLowerCase() === 'cmd.exe',
  });
  if (log) writeFileSync(log, result.stdout + result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${executable} exited ${result.status}: ${log ?? result.stderr.trim()}`);
  return result.stdout.trim();
}

function git(repo: string, args: string[]) {
  return run('git', ['-C', repo, ...args], repo);
}

function requireOfficialOrigin(repo: string) {
  const origin = git(repo, ['remote', 'get-url', 'origin']);
  if (origin !== 'https://github.com/turboderp-org/exllamav3.git') {
    throw new Error(`Expected official EXL3 origin, received ${origin}`);
  }
}

export function validateWheelSource(repo: string) {
  if (git(repo, ['status', '--porcelain']).length > 0) {
    throw new Error('EXL3 source is dirty; preserve local changes before building.');
  }
  const commit = CommitSchema.parse(git(repo, ['rev-parse', 'HEAD']));
  const upstream = CommitSchema.parse(git(repo, ['rev-parse', 'origin/dev']));
  const base = git(repo, ['merge-base', 'HEAD', 'origin/dev']);
  if (base === commit && commit !== upstream) throw new Error('EXL3 source is behind origin/dev; fast-forward it first.');
  if (base !== upstream) throw new Error('EXL3 source has diverged from origin/dev; merge or rebase onto it first.');
  const localCommits = git(repo, ['log', '--format=%h %s', `${upstream}..HEAD`]).split(/\r?\n/u).filter(Boolean);
  return { commit, upstream, localCommits };
}

export function selectBuiltWheel(directory: string, version: string) {
  const wheels = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^exllamav3-.*\.whl$/u.test(entry.name))
    .map((entry) => entry.name);
  const wheel = wheels[0];
  if (wheels.length !== 1 || !wheel) throw new Error(`Expected exactly one EXL3 wheel in ${directory}, found ${wheels.length}.`);
  if (!wheel.startsWith(`exllamav3-${version}-`)) throw new Error(`Wheel ${wheel} does not match source version ${version}.`);
  return path.join(directory, wheel);
}

export function buildJobCount(logicalCpus: number) {
  return Math.max(1, Math.floor(logicalCpus / 2));
}

function hashFile(file: string) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function samePath(left: string, right: string) {
  return realpathSync(left).toLowerCase() === realpathSync(right).toLowerCase();
}

export function readMsvcEnvironment(vcvars: string, cwd: string) {
  const comspec = AbsolutePathSchema.parse(process.env.ComSpec);
  const environmentText = run(comspec, ['/d', '/s', '/c', `""${path.normalize(vcvars)}" >nul && set"`], cwd);
  const environment: NodeJS.ProcessEnv = { ...process.env };
  for (const line of environmentText.split(/\r?\n/u)) {
    const separator = line.indexOf('=');
    if (separator > 0) environment[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return environment;
}

function createBuildEnvironment(toolchain: z.infer<typeof ToolchainSchema>, jobs: number) {
  const env = readMsvcEnvironment(toolchain.vcvars, toolchain.scratch);
  const torch = TorchInfoSchema.parse(JSON.parse(run(
    toolchain.python, ['-c', 'import json, torch; print(json.dumps(dict(version=torch.__version__, cuda=torch.version.cuda, arch=".".join(map(str,torch.cuda.get_device_capability(0))))))'], toolchain.scratch,
  )));
  const nvcc = run(path.join(toolchain.cuda, 'bin', 'nvcc.exe'), ['--version'], toolchain.scratch);
  if (!nvcc.includes(`release ${torch.cuda},`)) throw new Error('CUDA toolkit does not match the installed Torch CUDA version.');
  Object.assign(env, {
    CUDA_HOME: toolchain.cuda, CUDA_PATH: toolchain.cuda, TORCH_CUDA_ARCH_LIST: torch.arch,
    MAX_JOBS: String(jobs), DISTUTILS_USE_SDK: '1', EXLLAMA_VERBOSE: '1',
    TEMP: toolchain.scratch, TMP: toolchain.scratch,
  });
  // Windows environment keys are case-insensitive; send a single PATH to the child.
  const previousPath = env.Path ?? env.PATH ?? '';
  delete env.Path;
  env.PATH = `${path.join(toolchain.cuda, 'bin')};${path.dirname(toolchain.python)};${previousPath}`;
  delete env.EXLLAMA_NOCOMPILE;
  return { env, torch };
}

function probeRuntime(python: string, scratch: string) {
  const output = run(python, ['-c', [
    'import json, importlib.metadata as md, torch, exllamav3, exllamav3_ext',
    'torch.ones(1, device="cuda").add_(1); torch.cuda.synchronize()',
    'print(json.dumps(dict(version=md.version("exllamav3"), source=exllamav3.__file__, extension=exllamav3_ext.__file__, torch=torch.__version__, cuda=torch.version.cuda, available=torch.cuda.is_available(), gpu=torch.cuda.get_device_name(0), capability=list(torch.cuda.get_device_capability(0)))))',
  ].join('\n')], scratch);
  const lastLine = output.split(/\r?\n/u).at(-1);
  if (!lastLine) throw new Error('Runtime probe returned no JSON');
  return RuntimeSchema.parse(JSON.parse(lastLine));
}

function sourceVersion(repo: string) {
  const match = /__version__ = "([^"]+)"/u.exec(readFileSync(path.join(repo, 'exllamav3', 'version.py'), 'utf8'));
  if (!match?.[1]) throw new Error('Could not read exllamav3/version.py');
  return match[1];
}

export function buildExllamav3Wheel(options: z.infer<typeof WheelOptionsSchema>) {
  if (process.platform !== 'win32') throw new Error('This builder requires Windows and MSVC.');
  mkdirSync(options.scratch, { recursive: true });
  requireOfficialOrigin(options.repo);
  const source = validateWheelSource(options.repo);
  const version = sourceVersion(options.repo);
  const outDir = path.join(options.packages, source.commit.slice(0, 7));
  if (existsSync(outDir) && readdirSync(outDir).length > 0) throw new Error(`${outDir} already holds a build; remove it to rebuild this commit.`);
  mkdirSync(outDir, { recursive: true });
  const jobs = options.jobs ?? buildJobCount(availableParallelism());
  const { env, torch } = createBuildEnvironment(options, jobs);
  run(options.python, ['-m', 'pip', 'wheel', '--no-deps', '--no-build-isolation', '--no-cache-dir', '--wheel-dir', outDir, options.repo],
    options.scratch, env, path.join(options.scratch, 'exl3-wheel-build.log'));
  const wheel = selectBuiltWheel(outDir, version);
  const wheelSha256 = hashFile(wheel);
  writeFileSync(path.join(outDir, 'wheel.sha256'), `${wheelSha256} *${path.basename(wheel)}\n`);
  writeFileSync(path.join(outDir, 'source.sha'), `${source.commit}\n`);
  run(options.python, ['-m', 'pip', 'install', '--no-deps', '--force-reinstall', wheel], options.scratch, undefined, path.join(options.scratch, 'exl3-wheel-install.log'));
  run(options.python, ['-m', 'pip', 'check'], options.scratch);
  const runtime = probeRuntime(options.python, options.scratch);
  const sitePackages = AbsolutePathSchema.parse(run(options.python, ['-c', 'import sysconfig; print(sysconfig.get_path("platlib"))'], options.scratch));
  if (!samePath(path.dirname(path.dirname(runtime.source)), sitePackages) || !samePath(path.dirname(runtime.extension), sitePackages)) {
    throw new Error(`Installed EXL3 does not resolve to ${sitePackages}: ${runtime.source}, ${runtime.extension}`);
  }
  if (runtime.version !== version) throw new Error(`Installed ${runtime.version} but source is ${version}.`);
  if (runtime.torch !== torch.version || runtime.cuda !== torch.cuda) throw new Error('Install replaced the Torch stack.');
  if (validateWheelSource(options.repo).commit !== source.commit) throw new Error('EXL3 source changed during build.');
  const manifest = WheelManifestSchema.parse({ ...runtime, ...source, wheel: path.basename(wheel), wheelSha256, jobs });
  writeFileSync(path.join(outDir, 'build.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: {
    repo: { type: 'string' }, python: { type: 'string' }, cuda: { type: 'string' }, vcvars: { type: 'string' },
    scratch: { type: 'string' }, packages: { type: 'string' }, jobs: { type: 'string' },
  } });
  console.log(JSON.stringify(buildExllamav3Wheel(WheelOptionsSchema.parse(values)), null, 2));
}
