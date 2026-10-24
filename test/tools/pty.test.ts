import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeLog, ptyCommand } from '../../src/tools/background/pty.js';
import { SHELL, SHELL_FLAGS } from '../../src/tools/bash/shell.js';

test('decodeLog drops the pty artefacts: CRLF and the echoed EOF', () => {
  assert.equal(decodeLog('^D\x08\x08hello\r\nworld\r\n', 0), 'hello\nworld\n');
  // Past the start of the log the "EOF" text is ordinary output, not an artefact.
  assert.equal(decodeLog('hello\r\n', 100), 'hello\n');
});

test('ptyCommand hands the command to script(1) in the shape each platform wants', () => {
  assert.deepEqual(ptyCommand('echo hi', 'darwin'), [
    '-q',
    '/dev/null',
    SHELL,
    ...SHELL_FLAGS,
    'echo hi',
  ]);
  const linux = ptyCommand("echo 'hi'", 'linux');
  assert.deepEqual(linux.slice(0, 3), ['-q', '-e', '-c']);
  assert.equal(linux.at(-1), '/dev/null');
  assert.equal(linux[3], `${SHELL} ${SHELL_FLAGS.join(' ')} 'echo '\\''hi'\\'''`);
});
