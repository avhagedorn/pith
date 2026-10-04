import { PassThrough } from 'node:stream';
import * as ansi from './ansi.js';

const PLACEHOLDER = /\[paste #(\d+): \d+ lines\]/g;

// How many characters at the end of `text` could be the start of `marker`.
function partialMarker(text: string, marker: string): number {
  for (let n = Math.min(text.length, marker.length - 1); n > 0; n--) {
    if (marker.startsWith(text.slice(-n))) return n;
  }
  return 0;
}

export interface Keyboard {
  setRawMode(on: boolean): unknown;
  on(event: 'data', listener: (data: Buffer) => void): unknown;
  off(event: 'data', listener: (data: Buffer) => void): unknown;
  resume(): unknown;
  pause(): unknown;
}

/**
 * Sits between the keyboard and readline while the prompt is open. With bracketed paste on,
 * a multi-line paste is held back and shown as "[paste #1: 10 lines]"; `expand` puts the text
 * back before the message is sent. Terminals without bracketed paste just pass straight through.
 */
export function pasteCollapser(keyboard: Keyboard, screen: { write(text: string): unknown }) {
  const input = new PassThrough();
  const pastes: string[] = [];
  let pasting = false;
  let pasted = '';
  let carry = ''; // the start of a marker, cut off at the end of the last read

  const endPaste = () => {
    const text = pasted.replace(/\r\n?/g, '\n');
    pasted = '';
    if (!text.includes('\n')) return void input.write(text);
    pastes.push(text);
    input.write(`[paste #${pastes.length}: ${text.split('\n').length} lines]`);
  };

  const onData = (data: Buffer) => {
    let text = carry + data.toString('utf8');
    carry = '';
    while (text) {
      const marker = pasting ? ansi.PASTE_END : ansi.PASTE_START;
      const at = text.indexOf(marker);
      if (at < 0) {
        // A read can end partway through a marker; hold that part back for the next read.
        const keep = partialMarker(text, marker);
        const body = text.slice(0, text.length - keep);
        if (pasting) pasted += body;
        else input.write(body);
        carry = text.slice(text.length - keep);
        return;
      }
      if (pasting) {
        pasted += text.slice(0, at);
        endPaste();
      } else {
        input.write(text.slice(0, at));
      }
      pasting = !pasting;
      text = text.slice(at + marker.length);
    }
  };

  keyboard.setRawMode(true);
  keyboard.on('data', onData);
  keyboard.resume();
  screen.write(ansi.BRACKETED_PASTE_ON);

  return {
    input,
    expand: (message: string) =>
      message.replace(PLACEHOLDER, (whole, n: string) => pastes[Number(n) - 1] ?? whole),
    close() {
      keyboard.off('data', onData);
      keyboard.pause();
      keyboard.setRawMode(false);
      screen.write(ansi.BRACKETED_PASTE_OFF);
      input.end();
    },
  };
}
