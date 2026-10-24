import { spawn, execFile } from 'node:child_process';
import { join } from 'node:path';

export class ProcessError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message.slice(0, 2000)); this.code = code; }
}

/** Bounded trusted setup commands; never accepts a shell command string. */
export function runBounded(executable: string, args: string[], options: {
  env: NodeJS.ProcessEnv; cwd: string; timeoutMs: number; signal?: AbortSignal;
}): Promise<{stdout: string; stderr: string}> {
  if (options.signal?.aborted) return Promise.reject(new ProcessError('cancelled', 'Setup cancelled'));
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {env: options.env, cwd: options.cwd, shell: false,
      windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe']});
    let output: Buffer[] = [], errors: Buffer[] = [], outSize = 0, errSize = 0;
    let failure: ProcessError | undefined, finished = false;
    const stop = (error: ProcessError) => {
      if (finished || failure) return;
      failure = error;
      if (!child.pid) return;
      if (process.platform === 'win32') {
        execFile(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
          ['/PID', String(child.pid), '/T', '/F'], {windowsHide: true, timeout: 5000, maxBuffer: 32_768},
          () => { if (child.exitCode === null) child.kill(); });
      } else {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      }
    };
    const timer = setTimeout(() => stop(new ProcessError('timeout', 'Setup command timed out')), options.timeoutMs);
    const abort = () => stop(new ProcessError('cancelled', 'Setup cancelled'));
    options.signal?.addEventListener('abort', abort, {once: true});
    const cleanup = () => { finished = true; clearTimeout(timer); options.signal?.removeEventListener('abort', abort); };
    child.on('error', error => { cleanup(); reject(new ProcessError('launch-failed', error.message)); });
    child.stdout.on('data', (data: Buffer) => {
      outSize += data.length;
      if (outSize > 262_144) stop(new ProcessError('output-limit', 'Setup stdout exceeds 262,144 bytes'));
      else if (!failure) output.push(data);
    });
    child.stderr.on('data', (data: Buffer) => {
      errSize += data.length;
      if (errSize > 65_536) stop(new ProcessError('output-limit', 'Setup stderr exceeds 65,536 bytes'));
      else if (!failure) errors.push(data);
    });
    child.on('close', code => {
      cleanup();
      if (failure) { reject(failure); return; }
      try {
        const stdout = new TextDecoder('utf-8', {fatal: true}).decode(Buffer.concat(output));
        const stderr = Buffer.concat(errors).toString('utf8');
        if (code !== 0) throw new ProcessError('process-failed', stderr || stdout || `Setup command exited ${code}`);
        resolve({stdout, stderr});
      } catch (error) { reject(error); }
      output = []; errors = [];
    });
  });
}
