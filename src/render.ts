import type { ToolCall } from '@earendil-works/pi-ai';
import * as ansi from './ansi.js';
import type { ToolOutput } from './tools/index.js';

const MARK = '◆';
const HOLLOW_MARK = '◇'; // the off beat of a running row's blink
const FAILED_MARK = '✗'; // stands in for a red mark when colors are off
const ELLIPSIS = '…';
export const DASH = '─';
const MARK_COLOR = { run: ansi.DIM, wait: ansi.DIM, ok: ansi.GREEN, error: ansi.RED };
export type RowState = keyof typeof MARK_COLOR;

const lineCount = (text: unknown) =>
  typeof text === 'string' && text ? text.replace(/\n$/, '').split('\n').length : 0;
const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;

// Empty under a second, so fast tools stay uncluttered.
export function duration(ms: number): string {
  if (!(ms >= 1000)) return '';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const rest = seconds % 60;
  return `${Math.floor(seconds / 60)}m${rest ? `${rest}s` : ''}`;
}

// What the call is, in one line: "$ npm test", "read src/a.ts:10-29".
export function preview(call: ToolCall): string {
  const args = call.arguments ?? {};
  if (call.name === 'bash') return `$ ${args.command ?? '...'}`;
  if (call.name === 'search') return `search ${args.query ?? '...'}`;
  if (call.name === 'fetch') return `fetch ${args.url ?? '...'}`;

  let out = `${call.name} ${args.path ?? JSON.stringify(args)}`;
  if (call.name === 'read' && (args.offset || args.limit)) {
    const start = Number(args.offset ?? 1);
    out += `:${start}${args.limit ? `-${start + Number(args.limit) - 1}` : ''}`;
  }
  return out;
}

// What goes in the {braces}: line counts for edits, otherwise a gist of the result and how long.
export function detail(call: ToolCall, result: ToolOutput, ms: number): string {
  const args = call.arguments ?? {};
  if (!result.isError && call.name === 'edit') {
    return `+${lineCount(args.newText)}/-${lineCount(args.oldText)}`;
  }
  if (!result.isError && call.name === 'write') return `+${lineCount(args.content)}/-0`;

  const lines = result.text.split('\n').filter(line => line.trim());
  if (call.name === 'bash' && !result.isError) lines.pop(); // the trailing "exit 0"
  // A failure's last line says the most: "exit 1", "oldText not found."
  const gist = result.isError
    ? lines.at(-1)
    : lines.length > 1
      ? `${lines.length} lines`
      : lines[0];
  return [gist, duration(ms)].filter(Boolean).join(' · ');
}

const DIFF_COUNTS = /\{\+(\d+)\/-(\d+)\}$/;
const COLORED_DIFF_COUNTS = `{${ansi.GREEN}+$1${ansi.END_COLOR}/${ansi.RED}-$2${ansi.END_COLOR}}`;

// One tool row, cut to the terminal width so it can never wrap.
export function row(text: string, state: RowState, color: boolean, width: number): string {
  const room = width - `${MARK} `.length;
  let body = text.replace(/\s+/g, ' ').trim();
  if (body.length > room) body = body.slice(0, Math.max(0, room - 1)) + ELLIPSIS;
  const glyph = state === 'wait' ? HOLLOW_MARK : MARK;
  if (!color) return `${state === 'error' ? FAILED_MARK : glyph} ${body}`;

  body = body.replace(DIFF_COUNTS, COLORED_DIFF_COUNTS);
  const mark = `${MARK_COLOR[state]}${glyph}${ansi.RESET}`;
  return `${mark} ${state === 'error' ? body : `${ansi.DIM}${body}${ansi.RESET}`}`;
}

// A full-width line with text set into its left end: "── text ─────".
export const rule = (text: string, width: number) => `${DASH}${DASH} ${text} `.padEnd(width, DASH);

export interface TurnStats {
  reads: Set<string>;
  edits: Set<string>;
  commands: number;
  lookups: number;
  failed: number;
  cost: number;
  startedAt: number;
}
export const newStats = (): TurnStats => ({
  reads: new Set(),
  edits: new Set(),
  commands: 0,
  lookups: 0,
  failed: 0,
  cost: 0,
  startedAt: Date.now(),
});

// "Read 2 files, edited 1 file, ran 3 commands, 1 failed · 42s · ~$0.0009"
// "context 9% (12k tokens)": how full the conversation is, against whichever limit comes first.
export function contextUse(tokens: number, fill: number): string {
  const count =
    tokens < 1000 ? `${tokens}` : `${(tokens / 1000).toFixed(tokens < 10_000 ? 1 : 0)}k`;
  return `context ${Math.round(fill * 100)}% (${count} tokens)`;
}

export function summary(stats: TurnStats, ms: number, context = ''): string {
  const activity = [
    stats.reads.size && `read ${plural(stats.reads.size, 'file')}`,
    stats.edits.size && `edited ${plural(stats.edits.size, 'file')}`,
    stats.commands && `ran ${plural(stats.commands, 'command')}`,
    stats.lookups && `${plural(stats.lookups, 'web lookup')}`,
    stats.failed && `${stats.failed} failed`,
  ]
    .filter(Boolean)
    .join(', ');
  const capitalized = activity && activity[0]!.toUpperCase() + activity.slice(1);
  return [capitalized, duration(ms), `~$${stats.cost.toFixed(4)}`, context]
    .filter(Boolean)
    .join(' · ');
}
