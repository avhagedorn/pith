import * as ansi from './ansi.js';
import { row, type RowState } from './render.js';

const FALLBACK_WIDTH = 100;
const MAX_WIDTH = 110;
const CTRL_C = 3;
const BLINK_MS = 400;
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

  // A row that is still running blinks its mark until the next write replaces it.
  // Every other write stops the animation first.
  let animation: ReturnType<typeof setInterval> | undefined;
  const stopAnimation = () => {
    clearInterval(animation);
    animation = undefined;
  };
  const animate = (text: string) => {
    let lit = false;
    const draw = () => {
      lit = !lit;
      process.stderr.write(wipe + row(clean(text), lit ? 'run' : 'wait', color, width()));
    };
    draw();
    animation = setInterval(draw, BLINK_MS);
    animation.unref();
  };

  // However the process ends, the shell gets its cursor and key handling back.
  process.on('exit', () => {
    showCursor(true);
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
  });

  const styled = color && Boolean(process.stdout.isTTY);

  return {
    canRedraw,
    width,
    clean,
    // Whether model text may be styled. Piped stdout gets the raw markdown.
    styled,

    status(text: string, dimmed = false) {
      stopAnimation();
      const body = dimmed && color ? `${ansi.DIM}${clean(text)}${ansi.RESET}` : clean(text);
      process.stderr.write(`${wipe}${body}\n`);
    },

    // A transient row has no newline, so the next write overwrites it.
    row(text: string, state: RowState, placement: RowPlacement = 'keep') {
      stopAnimation();
      if (placement === 'transient') {
        if (canRedraw) animate(text);
        return;
      }
      const start = placement === 'replace-previous' ? `${wipe}${ansi.CURSOR_UP}${wipe}` : wipe;
      process.stderr.write(`${start}${row(clean(text), state, color, width())}\n`);
    },

    // Takes text that is already cleaned and styled.
    text(line: string) {
      stopAnimation();
      process.stderr.write(wipe);
      process.stdout.write(`${line}\n`);
    },

    // An earlier prompt, drawn like the live one. A long one shows its first line only.
    pastPrompt(text: string) {
      const [first = '', ...more] = clean(text).split('\n');
      const extra = more.length ? ` [+${more.length} lines]` : '';
      const [on, off] = styled ? [ansi.BOLD_CYAN, ansi.RESET] : ['', ''];
      process.stdout.write(`\n${on}❯ ${first}${extra}${off}\n\n`);
    },

    blankLine() {
      stopAnimation();
      process.stderr.write('\n');
    },

    // While busy the cursor is hidden and typing is discarded, so a visible cursor always
    // means "your turn" and stray keys cannot corrupt redrawn rows or leak into the prompt.
    busy(on: boolean) {
      if (!on) stopAnimation();
      showCursor(!on);
      muteKeys(on);
    },
  };
}
