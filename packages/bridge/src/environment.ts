import { open, mkdir, realpath, rename, link, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { resolve, join, isAbsolute } from 'node:path';
import { runBounded, ProcessError } from './process.ts';
import { runCore } from './core.ts';
import type { Request, Options } from './core.ts';

type Entry = {id: string; version: string; wheel_sha256: string; lock_sha256: string; python_version: string};
type State = {protocol: 1; active: Entry; previous: Entry | null};
type Context = {root: string; env: NodeJS.ProcessEnv; signal?: AbortSignal; onProgress?: (stage: string) => void};
export type PrepareOptions = {
  root: string; python: string; wheel: string; wheelSha256: string; version: string;
  requirements: string; requirementsSha256: string; allowNetwork?: boolean; wheelhouse?: string;
  env?: NodeJS.ProcessEnv; signal?: AbortSignal; onProgress?: (stage: string) => void;
};

export class EnvironmentError extends Error {
  code: string;
  stage: string;
  constructor(code: string, stage: string, message: string) {
    super(message.slice(0, 2000)); this.code = code; this.stage = stage;
  }
}
const hash = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const digest = /^[0-9a-f]{64}$/;
const version = /^\d+\.\d+\.\d+(?:\.dev\d+)?$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const pythonAt = (root: string, entry: Entry) => join(root, 'envs', entry.id, process.platform === 'win32' ? 'Scripts' : 'bin', process.platform === 'win32' ? 'python.exe' : 'python');

export function supportedPythonVersion(value: unknown): string {
  if (!Array.isArray(value) || value.length !== 3 || value.some(x => !Number.isInteger(x) || x < 0)
      || value[0] !== 3 || value[1] < 11 || value[1] > 13)
    throw new EnvironmentError('unsupported-python', 'python', 'Python 3.11 through 3.13 is required');
  return value.join('.');
}

export function isolatedEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = {...source};
  for (const key of Object.keys(env)) {
    if (/^(PYTHON|PIP_)/i.test(key) || /^(VIRTUAL_ENV|__PYVENV_LAUNCHER__)$/i.test(key)) delete env[key];
  }
  env.PIP_CONFIG_FILE = process.platform === 'win32' ? 'nul' : '/dev/null';
  env.PYTHONIOENCODING = 'utf-8';
  env.PYTHONUTF8 = '1';
  return env;
}

async function boundedRead(path: string, limit: number): Promise<Buffer> {
  const file = await open(path, 'r');
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (size <= limit) {
      const buffer = Buffer.alloc(Math.min(65_536, limit + 1 - size));
      const {bytesRead} = await file.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      size += bytesRead; chunks.push(buffer.subarray(0, bytesRead));
    }
    if (size > limit) throw new Error(`File exceeds ${limit} bytes`);
    return Buffer.concat(chunks);
  } finally { await file.close(); }
}

async function writeNew(path: string, bytes: Buffer | string) {
  const file = await open(path, 'wx', 0o600);
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
}

function validEntry(value: unknown): value is Entry {
  return object(value) && Object.keys(value).sort().join(',') === 'id,lock_sha256,python_version,version,wheel_sha256'
    && typeof value.id === 'string' && uuid.test(value.id)
    && typeof value.version === 'string' && value.version.length <= 64 && version.test(value.version)
    && typeof value.python_version === 'string' && /^3\.\d+\.\d+$/.test(value.python_version)
    && typeof value.wheel_sha256 === 'string' && digest.test(value.wheel_sha256)
    && typeof value.lock_sha256 === 'string' && digest.test(value.lock_sha256);
}

async function readState(root: string): Promise<{bytes: Buffer | null; state: State | null}> {
  let bytes: Buffer;
  try { bytes = await boundedRead(join(root, 'active.json'), 16_384); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {bytes: null, state: null}; throw error; }
  const value: unknown = JSON.parse(bytes.toString('utf8'));
  if (!object(value) || Object.keys(value).sort().join(',') !== 'active,previous,protocol'
      || value.protocol !== 1 || !validEntry(value.active) || !(value.previous === null || validEntry(value.previous)))
    throw new Error('Invalid managed-environment state');
  return {bytes, state: value as State};
}

function parsePins(bytes: Buffer): Record<string, string> {
  const pins: Record<string, string> = Object.create(null);
  for (const line of new TextDecoder('utf-8', {fatal: true}).decode(bytes).split(/\r?\n/)) {
    if (!line.trim() || line.startsWith('#')) continue;
    const match = /^([A-Za-z0-9][A-Za-z0-9_.-]*)==([0-9]+(?:\.[0-9]+)*(?:(?:a|b|rc|\.dev)[0-9]+)?)$/.exec(line);
    if (!match) throw new Error('Lock must contain exact name==version lines only');
    const name = match[1].toLowerCase().replace(/[-_.]+/g, '-');
    if (Object.hasOwn(pins, name) || ['pip', 'setuptools', 'vector-png-editor-core'].includes(name))
      throw new Error('Duplicate or reserved dependency in lock');
    pins[name] = match[2];
  }
  if (!Object.keys(pins).length) throw new Error('Empty runtime lock');
  return pins;
}

async function manifest(root: string, entry: Entry) {
  const directory = join(root, 'envs', entry.id);
  const stored: unknown = JSON.parse((await boundedRead(join(directory, 'ready.json'), 16_384)).toString('utf8'));
  if (!validEntry(stored) || JSON.stringify(stored) !== JSON.stringify(entry)) throw new Error('Environment manifest differs from active state');
  const lock = await boundedRead(join(directory, 'setup', 'requirements.lock'), 65_536);
  if (hash(lock) !== entry.lock_sha256) throw new Error('Environment lock snapshot changed');
  return parsePins(lock);
}

async function execute(context: Context, stage: string, python: string, args: string[], timeoutMs: number) {
  context.onProgress?.(stage);
  try {
    const command = args[0] === '-I' ? ['-I', '-X', 'utf8', ...args.slice(1)] : args;
    return await runBounded(python, command, {env: context.env, cwd: context.root, timeoutMs, signal: context.signal});
  } catch (error) {
    throw new EnvironmentError(error instanceof ProcessError ? error.code : 'setup-failed', stage, (error as Error).message);
  }
}

async function checkHealth(context: Context, entry: Entry, pins: Record<string, string>) {
  const python = pythonAt(context.root, entry);
  await checkVenv(context, entry);
  const installed = JSON.parse((await execute(context, 'packages', python, ['-I', '-m', 'pip', 'list', '--format=json', '--disable-pip-version-check'], 30_000)).stdout);
  if (!Array.isArray(installed)) throw new Error('Invalid installed-package report');
  const actual = new Map(installed.map(item => {
    if (!object(item) || typeof item.name !== 'string' || typeof item.version !== 'string') throw new Error('Invalid installed package');
    return [item.name.toLowerCase().replace(/[-_.]+/g, '-'), item.version];
  }));
  for (const [name, expected] of Object.entries({...pins, 'vector-png-editor-core': entry.version}))
    if (actual.get(name) !== expected) throw new EnvironmentError('health-failed', 'packages', `Installed version differs for ${name}`);
  for (const name of actual.keys())
    if (!Object.hasOwn(pins, name) && !['pip', 'setuptools', 'vector-png-editor-core'].includes(name)) throw new EnvironmentError('health-failed', 'packages', `Unpinned installed dependency: ${name}`);
  await execute(context, 'dependencies', python, ['-I', '-m', 'pip', 'check', '--disable-pip-version-check'], 30_000);
  const health = JSON.parse((await execute(context, 'render-health', python, ['-I', '-m', 'vector_png_editor.environment'], 30_000)).stdout);
  if (!object(health) || health.protocol !== 1 || health.kind !== 'environment' || !object(health.report)
      || health.report.healthy !== true || health.report.python_supported !== true
      || health.report.core_version !== entry.version || health.report.python_version !== entry.python_version
      || !object(health.report.render) || health.report.render.render !== 'passed') throw new EnvironmentError('health-failed', 'render-health', 'Environment health check failed');
}

async function checkVenv(context: Context, entry: Entry) {
  const actual = JSON.parse((await execute(context, 'venv-identity', pythonAt(context.root, entry),
    ['-I', '-c', 'import json,os,sys;print(json.dumps({"prefix":os.path.realpath(sys.prefix),"base":os.path.realpath(sys.base_prefix)}))'], 15_000)).stdout);
  const expected = await realpath(join(context.root, 'envs', entry.id));
  const normalize = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
  if (!object(actual) || typeof actual.prefix !== 'string' || typeof actual.base !== 'string'
      || normalize(actual.prefix) !== normalize(expected) || normalize(actual.prefix) === normalize(actual.base))
    throw new EnvironmentError('invalid-venv', 'venv-identity', 'Python is not running inside the staged dedicated venv');
}

async function activate(context: Context, before: {bytes: Buffer | null; state: State | null}, next: State) {
  context.onProgress?.('activate');
  if (context.signal?.aborted) throw new EnvironmentError('cancelled', 'activate', 'Setup cancelled before activation');
  const current = await readState(context.root);
  if (current.bytes?.toString('hex') !== before.bytes?.toString('hex')) throw new Error('Managed state changed during setup');
  const temp = join(context.root, `active.${randomUUID()}.tmp`);
  await writeNew(temp, JSON.stringify(next));
  try {
    if (context.signal?.aborted) throw new EnvironmentError('cancelled', 'activate', 'Setup cancelled before activation');
    if (before.bytes === null) await link(temp, join(context.root, 'active.json'));
    else await rename(temp, join(context.root, 'active.json'));
  } finally {
    try { await unlink(temp); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}

async function withLock<T>(options: {root: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal; onProgress?: (stage: string) => void}, work: (context: Context) => Promise<T>): Promise<T> {
  if (!isAbsolute(options.root)) throw new EnvironmentError('invalid-options', 'inputs', 'Use an absolute application-owned environment store');
  if (options.signal?.aborted) throw new EnvironmentError('cancelled', 'lock', 'Setup cancelled before starting');
  await mkdir(resolve(options.root), {recursive: true, mode: 0o700});
  const root = await realpath(resolve(options.root));
  let lock;
  try { lock = await open(join(root, 'setup.lock'), 'wx', 0o600); }
  catch (error) { throw new EnvironmentError((error as NodeJS.ErrnoException).code === 'EEXIST' ? 'busy' : 'io-error', 'lock', (error as Error).message); }
  try {
    return await work({root, env: isolatedEnvironment(options.env), signal: options.signal, onProgress: options.onProgress});
  } catch (error) {
    if (error instanceof EnvironmentError) throw error;
    throw new EnvironmentError('setup-failed', 'state', (error as Error).message);
  } finally { await lock.close(); await unlink(join(root, 'setup.lock')); }
}

export async function prepareEnvironment(options: PrepareOptions) {
  if (!version.test(options.version) || options.version.length > 64 || !digest.test(options.wheelSha256) || !digest.test(options.requirementsSha256)
      || !isAbsolute(options.python)) throw new EnvironmentError('invalid-options', 'inputs', 'Use an absolute trusted Python path, exact version and SHA-256 digests');
  return withLock(options, async context => {
    const before = await readState(context.root);
    if (before.state) await manifest(context.root, before.state.active);
    const wheel = await boundedRead(resolve(options.wheel), 50_000_000);
    const lock = await boundedRead(resolve(options.requirements), 65_536);
    if (hash(wheel) !== options.wheelSha256 || hash(lock) !== options.requirementsSha256) throw new Error('Wheel or dependency-lock digest differs');
    const pins = parsePins(lock);
    const probe = JSON.parse((await execute(context, 'python', options.python, ['-I', '-c', 'import json,sys;print(json.dumps({"version":list(sys.version_info[:3]),"venv":sys.prefix!=sys.base_prefix}))'], 15_000)).stdout);
    const pythonVersion = supportedPythonVersion(object(probe) ? probe.version : null);
    await mkdir(join(context.root, 'envs'), {recursive: true});
    const entry: Entry = {id: randomUUID(), version: options.version, wheel_sha256: options.wheelSha256,
      lock_sha256: options.requirementsSha256, python_version: pythonVersion};
    const directory = join(context.root, 'envs', entry.id);
    await mkdir(directory);
    await mkdir(join(directory, 'setup'));
    const wheelPath = join(directory, 'setup', `vector_png_editor_core-${entry.version}-py3-none-any.whl`);
    await writeNew(wheelPath, wheel);
    const lockPath = join(directory, 'setup', 'requirements.lock');
    await writeNew(lockPath, lock);
    await execute(context, 'venv', options.python, ['-I', '-m', 'venv', directory], 120_000);
    await checkVenv(context, entry);
    const python = pythonAt(context.root, entry);
    const args = ['-I', '-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', '--only-binary=:all:',
      '--no-compile', '--cache-dir', join(context.root, 'download-cache'), '--prefix', directory, '-r', lockPath, wheelPath];
    if (options.allowNetwork !== true) args.push('--no-index');
    if (options.wheelhouse) args.push('--find-links', resolve(options.wheelhouse));
    await execute(context, 'install', python, args, 300_000);
    await checkHealth(context, entry, pins);
    await writeNew(join(directory, 'ready.json'), JSON.stringify(entry));
    await activate(context, before, {protocol: 1, active: entry, previous: before.state?.active ?? null});
    return {entry, python};
  });
}

export async function activeEnvironment(root: string) {
  if (!isAbsolute(root)) throw new EnvironmentError('invalid-options', 'inputs', 'Use an absolute application-owned environment store');
  const context = await readState(resolve(root));
  if (!context.state) return null;
  await manifest(resolve(root), context.state.active);
  return {entry: context.state.active, python: pythonAt(resolve(root), context.state.active)};
}

export async function runManagedCore(root: string, request: Request, options: Omit<Options, 'cwd'> = {}) {
  const active = await activeEnvironment(root);
  if (!active) throw new EnvironmentError('no-active-environment', 'select', 'Set up a managed environment before using the Core');
  return runCore(active.python, request, {...options, cwd: await realpath(resolve(root)), env: isolatedEnvironment(options.env)});
}

export async function rollbackEnvironment(options: {root: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal; onProgress?: (stage: string) => void}) {
  return withLock(options, async context => {
    const before = await readState(context.root);
    if (!before.state?.previous) throw new EnvironmentError('no-previous-environment', 'rollback', 'No previous environment is recorded');
    const entry = before.state.previous;
    const pins = await manifest(context.root, entry);
    await checkHealth(context, entry, pins);
    await activate(context, before, {protocol: 1, active: entry, previous: before.state.active});
    return {entry, python: pythonAt(context.root, entry)};
  });
}
