import test from 'node:test';
import assert from 'node:assert/strict';
import { pasteCollapser } from '../src/paste.js';

const START = '\x1b[200~';
const END = '\x1b[201~';

function setup() {
  let listener: ((data: Buffer) => void) | undefined;
  const keyboard = {
    raw: false,
    setRawMode(on: boolean) {
      this.raw = on;
    },
    on: (_: 'data', l: (data: Buffer) => void) => (listener = l),
    off: () => (listener = undefined),
    resume: () => {},
    pause: () => {},
  };
  const screen: string[] = [];
  const paste = pasteCollapser(keyboard, { write: text => screen.push(text) });
  let received = '';
  paste.input.on('data', chunk => (received += chunk));
  const type = (...chunks: string[]) => chunks.forEach(chunk => listener?.(Buffer.from(chunk)));
  return { paste, type, keyboard, screen, received: () => received };
}

test('a multi-line paste is collapsed, and expanded again for the model', async () => {
  const { paste, type, received } = setup();
  type('fix this: ', `${START}line one\r\nline two\rline three${END}`, ' thanks');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(received(), 'fix this: [paste #1: 3 lines] thanks');
  assert.equal(paste.expand(received()), 'fix this: line one\nline two\nline three thanks');
});

test('a single-line paste and plain typing pass straight through', async () => {
  const { type, received } = setup();
  type('ab', `${START}one line${END}`, 'c');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(received(), 'abone linec');
});

test('markers split across reads still work', async () => {
  const { paste, type, received } = setup();
  type('\x1b[20', '0~a\nb\x1b[2', '01~!');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(received(), '[paste #1: 2 lines]!');
  assert.equal(paste.expand(received()), 'a\nb!');
});

test('the terminal is put into and out of paste mode', () => {
  const { paste, keyboard, screen } = setup();
  assert.equal(keyboard.raw, true);
  paste.close();
  assert.equal(keyboard.raw, false);
  assert.deepEqual(screen, ['\x1b[?2004h', '\x1b[?2004l']);
});
