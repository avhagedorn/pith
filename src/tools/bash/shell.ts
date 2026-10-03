import { spawn } from 'node:child_process';
import { errorCode } from '../../errors.js';
import { MAX_OUTPUT_BYTES, type ToolOutput } from '../shared.js';

export const DEFAULT_TIMEOUT_S = 30;
// Head, tail and this reserve (for the gap marker and exit status) add up to the result cap.
const RESERVED_BYTES = 1024;
const HEAD_BYTES = 8 * 1024;
const TAIL_BYTES = MAX_OUTPUT_BYTES - HEAD_BYTES - RESERVED_BYTES;
const SHELL = '/bin/bash';
// No profile or rc file: startup scripts would run with the user's full setup.
const SHELL_FLAGS = ['--noprofile', '--norc', '-c'];
const INHERITED_VARIABLES = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TMPDIR',
];
const FIXED_VARIABLES = { TERM: 'dumb', NO_COLOR: '1', CI: '1' };

// The child gets an allowlist, not the harness's environment, so API keys stay out of it.
// This limits exposure. It is not isolation: the shell can still read HOME.
export function shellEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const inherited: NodeJS.ProcessEnv = {};
  for (const name of INHERITED_VARIABLES) {
    if (env[name]) inherited[name] = env[name];
  }
  return { ...inherited, ...FIXED_VARIABLES };
}

export async function runShell(
  command: string,
  cwd: string,
  signal: AbortSignal,
  timeoutMs = DEFAULT_TIMEOUT_S * 1000,
): Promise<ToolOutput> {
  signal.throwIfAborted();
  if (process.platform === 'win32') {
    throw new Error('This prototype supports macOS/Linux shell execution only.');
  }

  return new Promise((resolve, reject) => {
    // Detached puts the child in its own process group, so the whole group can be killed.
    const child = spawn(SHELL, [...SHELL_FLAGS, command], {
      cwd,
      env: shellEnvironment(),
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Long output keeps both ends: commands tend to put what matters last.
    const head: Buffer[] = [];
    const tail: Buffer[] = [];
    let headBytes = 0;
    let tailBytes = 0;
    let totalBytes = 0;
    // Keeps reading past the cap: a full pipe would block the child forever.
    const capture = (chunk: Buffer) => {
      totalBytes += chunk.length;
      const headRoom = HEAD_BYTES - headBytes;
      if (headRoom > 0) {
        const part = chunk.subarray(0, headRoom);
        head.push(part);
        headBytes += part.length;
        chunk = chunk.subarray(part.length);
      }
      if (!chunk.length) return;
      tail.push(chunk);
      tailBytes += chunk.length;
      // Whole chunks are dropped from the front once the rest still fills the tail.
      while (tailBytes - tail[0]!.length >= TAIL_BYTES) tailBytes -= tail.shift()!.length;
    };
    const capturedOutput = () => {
      const end = Buffer.concat(tail).subarray(-TAIL_BYTES);
      const omitted = totalBytes - headBytes - end.length;
      const gap = omitted ? `\n[… ${omitted} bytes truncated …]\n` : '';
      return `${Buffer.concat(head).toString('utf8')}${gap}${end.toString('utf8')}`;
    };

    const killGroup = () => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch (error) {
        if (errorCode(error) !== 'ESRCH') child.kill('SIGKILL');
      }
    };

    // The first reason to stop wins and replaces the exit status in the result.
    let stopReason: string | undefined;
    const stop = (reason: string) => {
      stopReason ??= reason;
      killGroup();
    };
    const onAbort = () =>
      stop('Cancelled. The command may already have changed files; inspect before retrying.');
    const timer = setTimeout(
      () => stop(`Timed out after ${timeoutMs}ms. Inspect changes before retrying.`),
      timeoutMs,
    );
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    };

    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();

    child.once('error', error => {
      cleanup();
      reject(error);
    });
    child.once('close', (code, exitSignal) => {
      cleanup();
      killGroup(); // Anything the command left in the background dies with it.
      const status = stopReason ?? `exit ${code ?? exitSignal}`;
      resolve({
        text: `${capturedOutput()}\n${status}`,
        isError: Boolean(stopReason) || code !== 0,
      });
    });
  });
}
