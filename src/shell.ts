import { spawn } from 'node:child_process';

export const MAX_OUTPUT_BYTES = 32 * 1024;

// Do not hand the model's subprocess all of the harness's credentials.
// This is exposure reduction, NOT isolation: a local shell can still read HOME.
export function shellEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR']) {
    if (env[key]) clean[key] = env[key];
  }
  return { ...clean, TERM: 'dumb', NO_COLOR: '1', CI: '1' };
}

export async function runShell(
  command: string,
  cwd: string,
  signal: AbortSignal,
  timeoutMs = 30_000,
): Promise<{ text: string; isError: boolean }> {
  signal.throwIfAborted();
  if (process.platform === 'win32') throw new Error('This prototype supports macOS/Linux shell execution only.');
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/bash', ['--noprofile', '--norc', '-c', command], {
      cwd,
      env: shellEnvironment(),
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let reason: string | undefined;
    let captured = 0;
    let truncated = false;
    const chunks: Buffer[] = [];
    const capture = (chunk: Buffer) => {
      const remaining = MAX_OUTPUT_BYTES - captured;
      if (chunk.length > remaining) truncated = true;
      if (remaining > 0) {
        const part = chunk.subarray(0, remaining);
        chunks.push(part);
        captured += part.length;
      }
      // Continue draining both streams after the cap to avoid deadlock.
    };
    const killGroup = () => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') child.kill('SIGKILL');
      }
    };
    const stop = (message: string) => {
      reason ??= message;
      killGroup();
    };
    const abort = () => stop('Cancelled. The command may already have changed files; inspect before retrying.');
    const timer = setTimeout(() => stop(`Timed out after ${timeoutMs}ms. Inspect changes before retrying.`), timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
    };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    child.once('error', error => {
      cleanup();
      reject(error);
    });
    child.once('close', (code, exitSignal) => {
      cleanup();
      killGroup(); // No persistent background jobs in v0.
      const output = Buffer.concat(chunks).toString('utf8');
      resolve({
        text: `${output}${truncated ? '\n[output truncated at 32 KiB]' : ''}\n${reason ?? `exit ${code ?? exitSignal}`}`,
        isError: Boolean(reason) || code !== 0,
      });
    });
  });
}
