import test from 'node:test';
import assert from 'node:assert/strict';
import type { ToolCall, Usage } from '@earendil-works/pi-ai';
import type { Terminal } from '../src/terminal.js';
import { createTranscript } from '../src/transcript.js';

// Records what the transcript asks the terminal to show, instead of showing it.
function fakeTerminal(canRedraw = true) {
  const shown: string[] = [];
  const term: Terminal = {
    canRedraw,
    styled: false,
    width: () => 60,
    clean: text => text,
    status: text => shown.push(`status: ${text}`),
    row: (text, state, placement = 'keep') => shown.push(`${placement} ${state}: ${text}`),
    text: line => shown.push(`text: ${line}`),
    blankLine: () => shown.push(''),
    busy: () => {},
  };
  return { term, shown };
}
const read = (path: string): ToolCall => ({
  type: 'toolCall',
  id: path,
  name: 'read',
  arguments: { path },
});
const bash: ToolCall = { type: 'toolCall', id: 'b', name: 'bash', arguments: { command: 'ls' } };
const ok = { text: 'one\ntwo', isError: false };
const failed = { text: 'boom\nexit 1', isError: true };

test('consecutive successes of one tool share a row; a failure gets its own', () => {
  const { term, shown } = fakeTerminal();
  const transcript = createTranscript(term);
  transcript.begin();
  for (const call of [read('a'), read('b')]) {
    transcript.onProgress({ type: 'tool-start', call });
    transcript.onProgress({ type: 'tool-end', call, result: ok });
  }
  transcript.onProgress({ type: 'tool-end', call: read('c'), result: failed });
  transcript.onProgress({
    type: 'tool-end',
    call: bash,
    result: { text: 'x\nexit 0', isError: false },
  });
  assert.deepEqual(shown, [
    'transient run: read a {running}',
    'keep ok: read a {2 lines}',
    'transient run: read b {running}',
    'replace-previous ok: 2× read b {2 lines}',
    'keep error: read c {exit 1}',
    'keep ok: $ ls {x}',
  ]);
});

test('without a redrawable terminal every call keeps its own row', () => {
  const { term, shown } = fakeTerminal(false);
  const transcript = createTranscript(term);
  transcript.onProgress({ type: 'tool-end', call: read('a'), result: ok });
  transcript.onProgress({ type: 'tool-end', call: read('b'), result: ok });
  assert.deepEqual(shown, ['keep ok: read a {2 lines}', 'keep ok: read b {2 lines}']);
});

test('text prints a finished line at a time, trims blank ends and breaks a burst', () => {
  const { term, shown } = fakeTerminal();
  const transcript = createTranscript(term);
  transcript.onProgress({ type: 'tool-end', call: read('a'), result: ok });
  transcript.onProgress({ type: 'text', text: '\n\nfirst li' });
  assert.equal(shown.length, 1);
  transcript.onProgress({ type: 'text', text: 'ne\n\n\n\nsecond' });
  transcript.onProgress({ type: 'text', text: ' line\n\n' });
  transcript.onProgress({ type: 'tool-end', call: read('b'), result: ok });
  assert.deepEqual(shown.slice(1), [
    'text: first line',
    'text: \nsecond line',
    'keep ok: read b {2 lines}',
  ]);
});

test('the turn ends with leftover text, any stop reason and a summary rule', () => {
  const { term, shown } = fakeTerminal();
  const transcript = createTranscript(term);
  transcript.begin();
  const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.0004 };
  const usage: Usage = { input: 1, output: 1, totalTokens: 2, cacheRead: 0, cacheWrite: 0, cost };
  transcript.onProgress({ type: 'usage', usage });
  transcript.onProgress({ type: 'tool-end', call: bash, result: failed });
  transcript.onProgress({ type: 'text', text: 'unfinished' });
  transcript.end({ reason: 'aborted', detail: 'Cancelled.' });
  assert.deepEqual(shown.slice(1), [
    'text: unfinished',
    'status: [aborted] Cancelled.',
    `status: ${'── Ran 1 command, 1 failed · ~$0.0004 '.padEnd(60, '─')}`,
  ]);
});
