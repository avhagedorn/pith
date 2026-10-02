import { spawn } from 'node:child_process';
import { errorCode } from '../../errors.js';
import { MAX_OUTPUT_BYTES, TRUNCATION_NOTICE, type ToolOutput } from '../shared.js';

export const DEFAULT_TIMEOUT_S = 30;
export const MAX_TIMEOUT_S = 120;
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

    const chunks: Buffer[] = [];
    let captured = 0;
    let truncated = false;
    // Keeps reading past the cap: a full pipe would block the child forever.
    const capture = (chunk: Buffer) => {
      const remaining = MAX_OUTPUT_BYTES - captured;
      if (chunk.length > remaining) truncated = true;
      if (remaining <= 0) return;
      const part = chunk.subarray(0, remaining);
      chunks.push(part);
      captured += part.length;
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
      const output = Buffer.concat(chunks).toString('utf8');
      const status = stopReason ?? `exit ${code ?? exitSignal}`;
      resolve({
        text: `${output}${truncated ? TRUNCATION_NOTICE : ''}\n${status}`,
        isError: Boolean(stopReason) || code !== 0,
      });
    });
  });
}
