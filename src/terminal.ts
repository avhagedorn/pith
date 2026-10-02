import * as ansi from './ansi.js';
import { row, type RowState } from './render.js';

const FALLBACK_WIDTH = 100;
const MAX_WIDTH = 110;
const CTRL_C = 3;
// Everything below space except tab and newline, plus DEL and the C1 range.
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

// Model and tool output must never be able to drive the terminal.
export const terminalText = (text: string) => text.replace(CONTROL_CHARACTERS, '');

export type RowPlacement = 'keep' | 'transient' | 'replace-previous';
export type Terminal = ReturnType<typeof createTerminal>;

/**
 * All terminal output. Status goes to stderr, model text to stdout.
 * There is no screen: the only cursor moves are redrawing the current line or the row above.
 * `clean` strips whatever must not be shown; `onInterrupt` is called on Ctrl-C while busy.
 */
export function createTerminal(clean: (text: string) => string, onInterrupt: () => void) {
  const canRedraw = Boolean(process.stderr.isTTY);
  const color = canRedraw && !process.env.NO_COLOR;
  const wipe = canRedraw ? ansi.CLEAR_LINE : '';
  const width = () => Math.min(process.stderr.columns || FALLBACK_WIDTH, MAX_WIDTH);

  const showCursor = (show: boolean) => {
    if (canRedraw) process.stderr.write(show ? ansi.SHOW_CURSOR : ansi.HIDE_CURSOR);
  };

  // Raw mode stops the terminal echoing keys, but also stops it turning Ctrl-C into SIGINT.
  const swallowKeys = (data: Buffer) => {
    if (data.includes(CTRL_C)) onInterrupt();
  };
  const muteKeys = (mute: boolean) => {
    if (!process.stdin.isTTY) return;
    process.stdin.setRawMode(mute);
    if (mute) process.stdin.on('data', swallowKeys).resume();
    else process.stdin.off('data', swallowKeys).pause();
  };

  // However the process ends, the shell gets its cursor and key handling back.
  process.on('exit', () => {
    showCursor(true);
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
  });

  return {
    canRedraw,
    width,
    clean,
    // Whether model text may be styled. Piped stdout gets the raw markdown.
    styled: color && Boolean(process.stdout.isTTY),

    status(text: string, dimmed = false) {
      const body = dimmed && color ? `${ansi.DIM}${clean(text)}${ansi.RESET}` : clean(text);
      process.stderr.write(`${wipe}${body}\n`);
    },

    // A transient row has no newline, so the next write overwrites it.
    row(text: string, state: RowState, placement: RowPlacement = 'keep') {
      if (placement === 'transient' && !canRedraw) return;
      const start = placement === 'replace-previous' ? `${wipe}${ansi.CURSOR_UP}${wipe}` : wipe;
      const end = placement === 'transient' ? '' : '\n';
      process.stderr.write(start + row(clean(text), state, color, width()) + end);
    },

    // Takes text that is already cleaned and styled.
    text(line: string) {
      process.stderr.write(wipe);
      process.stdout.write(`${line}\n`);
    },

    blankLine() {
      process.stderr.write('\n');
    },

    // While busy the cursor is hidden and typing is discarded, so a visible cursor always
    // means "your turn" and stray keys cannot corrupt redrawn rows or leak into the prompt.
    busy(on: boolean) {
      showCursor(!on);
      muteKeys(on);
    },
  };
}
