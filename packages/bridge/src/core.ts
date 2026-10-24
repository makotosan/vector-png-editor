import { spawn, execFile } from 'node:child_process';
import { join } from 'node:path';

export type Command = 'inspect' | 'extract' | 'validate' | 'build' | 'verify' | 'rebuild';
export type Request = {
  protocol: 1; command: Command; request_id: string; input?: string; output?: string;
  source_base64?: string; width?: number; height?: number; syntax_only?: boolean;
  overwrite?: boolean; expected_sha256?: string;
};
export type Result = { protocol: 1; command: Command; request_id: string; ok: boolean;
  result?: Record<string, unknown>;
  error?: {code: string; message: string; details?: Record<string, unknown>};
};
export type Options = { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; signal?: AbortSignal };

const codes: Record<string, number> = {
  'invalid-arguments': 2, 'invalid-container': 3, 'invalid-svg': 4, 'unsupported-profile': 5,
  'resource-limit': 6, 'ordinary-png': 7, 'io-error': 8, 'output-exists': 9,
  'render-failed': 10, 'render-timeout': 11, 'render-mismatch': 12, conflict: 13, cancelled: 14,
};
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export class BridgeError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

function validateResult(value: unknown, request: Request, exit: number | null): Result {
  if (!object(value) || value.protocol !== 1 || value.command !== request.command
      || value.request_id !== request.request_id || typeof value.ok !== 'boolean'
      || Object.keys(value).some(key => !['protocol', 'command', 'request_id', 'ok', 'result', 'error'].includes(key)))
    throw new BridgeError('protocol-error', 'Unexpected Core response envelope or request ID');
  if (value.ok) {
    if (exit !== 0 || !object(value.result) || 'error' in value)
      throw new BridgeError('protocol-error', 'Inconsistent Core success');
  } else {
    const error = value.error;
    if ('result' in value || !object(error) || typeof error.code !== 'string'
        || !Object.hasOwn(codes, error.code) || codes[error.code] !== exit
        || typeof error.message !== 'string' || [...error.message].length > 2000
        || ('details' in error && !object(error.details))
        || Object.keys(error).some(key => !['code', 'message', 'details'].includes(key)))
      throw new BridgeError('protocol-error', 'Inconsistent Core error');
  }
  return value as Result;
}

// One process per request; no shell, no caller-controlled executable arguments.
export function runCore(python: string, request: Request, options: Options = {}): Promise<{ response: Result; diagnostics: string }> {
  let wire: string;
  try { wire = JSON.stringify(request); }
  catch { return Promise.reject(new BridgeError('invalid-request', 'Request is not JSON serializable')); }
  if (Buffer.byteLength(wire) > 2_000_000 || typeof request.request_id !== 'string'
      || [...request.request_id].length < 1 || [...request.request_id].length > 128)
    return Promise.reject(new BridgeError('invalid-request', 'Request exceeds transport limits'));
  const timeout = options.timeoutMs ?? 60_000;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 120_000)
    return Promise.reject(new BridgeError('invalid-request', 'Invalid timeout'));
  // Save cancellation cannot promise rollback across its commit boundary.
  if (options.signal && ['extract', 'build', 'rebuild'].includes(request.command))
    return Promise.reject(new BridgeError('invalid-request', 'AbortSignal is restricted to read-only operations'));
  if (options.signal?.aborted) return Promise.reject(new BridgeError('cancelled', 'Request cancelled before launch'));
  return new Promise((resolve, reject) => {
    const child = spawn(python, ['-m', 'vector_png_editor', '--request-json'], {
      cwd: options.cwd, env: options.env, shell: false, windowsHide: true,
      detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout: Buffer[] = [], stderr: Buffer[] = [];
    let outBytes = 0, errBytes = 0, failure: BridgeError | undefined, finished = false;
    const stop = (reason: BridgeError) => {
      if (finished || failure) return;
      failure = reason;
      if (!child.pid) return;
      if (process.platform === 'win32') {
        execFile(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
          ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000, maxBuffer: 32_768 },
          () => { if (child.exitCode === null) child.kill(); });
      } else {
        try { process.kill(-child.pid, 'SIGKILL'); }
        catch { child.kill('SIGKILL'); }
      }
    };
    const timer = setTimeout(() => stop(new BridgeError('timeout', 'Core request timed out')), timeout);
    const abort = () => stop(new BridgeError('cancelled', 'Core request cancelled'));
    options.signal?.addEventListener('abort', abort, { once: true });
    const cleanup = () => { finished = true; clearTimeout(timer); options.signal?.removeEventListener('abort', abort); };
    child.on('error', error => { cleanup(); reject(new BridgeError('launch-failed', error.message)); });
    child.stdin.on('error', () => { /* close/error below determines the protocol outcome */ });
    child.stdout.on('data', (data: Buffer) => {
      outBytes += data.length;
      if (outBytes > 262_144) stop(new BridgeError('output-limit', 'Core stdout exceeds 262,144 bytes'));
      else if (!failure) stdout.push(data);
    });
    child.stderr.on('data', (data: Buffer) => {
      errBytes += data.length;
      if (errBytes > 65_536) stop(new BridgeError('output-limit', 'Core stderr exceeds 65,536 bytes'));
      else if (!failure) stderr.push(data);
    });
    child.on('close', exit => {
      cleanup();
      if (failure) { reject(failure); return; }
      try {
        const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(stdout)));
        resolve({ response: validateResult(value, request, exit), diagnostics: Buffer.concat(stderr).toString('utf8') });
      } catch (error) {
        reject(error instanceof BridgeError ? error : new BridgeError('protocol-error', 'Core returned invalid JSON/UTF-8'));
      }
      stdout = []; stderr = [];
    });
    child.stdin.end(wire);
  });
}

// Each instance belongs to one document. Save operations never use this preview lane.
export class LatestValidation {
  generation = 0;
  active?: AbortController;
  async run(python: string, request: Request, options: Omit<Options, 'signal'> = {}) {
    if (request.command !== 'validate') throw new BridgeError('invalid-request', 'Preview lane accepts validate only');
    const generation = ++this.generation;
    this.active?.abort();
    const controller = new AbortController();
    this.active = controller;
    try {
      const result = await runCore(python, request, { ...options, signal: controller.signal });
      return generation === this.generation ? result : undefined;
    } catch (error) {
      if (generation !== this.generation || controller.signal.aborted) return undefined;
      throw error;
    } finally {
      if (generation === this.generation) this.active = undefined;
    }
  }
  dispose() { ++this.generation; this.active?.abort(); this.active = undefined; }
}
