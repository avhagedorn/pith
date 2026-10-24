import { spawnSync } from 'node:child_process';
import { SHELL, SHELL_FLAGS } from '../bash/shell.js';

// A program writing to a pipe buffers 4 KiB before flushing, so a job's log can stay empty for
// minutes while the job is working fine. On a pty it line-buffers, as it would in a terminal,
// which is what the model expects to see. Node has no pty API, so borrow the system's script(1).
let available: boolean | undefined;
export function hasPty(): boolean {
  if (process.platform === 'win32') return false;
  available ??= spawnSync('/bin/sh', ['-c', 'command -v script'], { stdio: 'ignore' }).status === 0;
  return available;
}

const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;

// macOS takes the command as trailing words; util-linux wants a single -c string and needs -e
// to pass the child's exit status through. Either way the pty sits on stdout and stderr.
export function ptyCommand(
  command: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  if (platform === 'darwin') return ['-q', '/dev/null', SHELL, ...SHELL_FLAGS, command];
  return ['-q', '-e', '-c', [SHELL, ...SHELL_FLAGS, quote(command)].join(' '), '/dev/null'];
}

// A pty renders every newline as CRLF, and this script's pty announces the EOF it read on its
// stdin by typing "^D" and then backing over it.
const EOF_ECHO = /^(?:\^D\x08\x08|\x04\x08\x08)+/;
export const decodeLog = (text: string, offset: number) =>
  (offset === 0 ? text.replace(EOF_ECHO, '') : text).replace(/\r\n/g, '\n');
