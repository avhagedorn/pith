import type { ToolCall } from '@earendil-works/pi-ai';
import type { ToolOutput } from './tools.js';

const lineCount = (text: unknown) => typeof text === 'string' && text ? text.replace(/\n$/, '').split('\n').length : 0;

// Sub-second durations render as "" so fast tools stay clutter-free.
export function duration(ms: number): string {
  if (!(ms >= 1000)) return '';
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${seconds % 60 ? `${seconds % 60}s` : ''}`;
}

export function preview(call: ToolCall): string {
  const args = call.arguments ?? {};
  if (call.name === 'bash') return `$ ${args.command ?? '...'}`;
  let out = `${call.name} ${args.path ?? JSON.stringify(args)}`;
  if (call.name === 'read' && (args.offset || args.limit)) {
    const start = Number(args.offset ?? 1);
    out += `:${start}${args.limit ? `-${start + Number(args.limit) - 1}` : ''}`;
  }
  return out;
}

// What goes in the {braces}: git-style counts for edits, otherwise a result gist and duration.
export function detail(call: ToolCall, result: ToolOutput, ms: number): string {
  const args = call.arguments ?? {};
  if (!result.isError && call.name === 'edit') return `+${lineCount(args.newText)}/-${lineCount(args.oldText)}`;
  if (!result.isError && call.name === 'write') return `+${lineCount(args.content)}/-0`;
  const lines = result.text.split('\n').filter(line => line.trim());
  if (call.name === 'bash' && !result.isError) lines.pop(); // trailing "exit 0"
  const gist = result.isError ? lines.at(-1) : lines.length > 1 ? `${lines.length} lines` : lines[0];
  return [gist, duration(ms)].filter(Boolean).join(' · ');
}

// One status row, cut to the terminal width so it never wraps.
export function row(text: string, state: 'run' | 'ok' | 'error', color: boolean, width: number): string {
  let body = text.replace(/\s+/g, ' ').trim();
  if (body.length > width - 2) body = `${body.slice(0, Math.max(0, width - 3))}…`;
  if (!color) return `${state === 'error' ? '✗' : '◆'} ${body}`;
  body = body.replace(/\{\+(\d+)\/-(\d+)\}$/, '{\x1b[32m+$1\x1b[39m/\x1b[31m-$2\x1b[39m}');
  const mark = { run: 2, ok: 32, error: 31 }[state];
  return `\x1b[${mark}m◆\x1b[0m ${state === 'error' ? body : `\x1b[2m${body}\x1b[0m`}`;
}

export interface TurnStats { reads: Set<string>; edits: Set<string>; commands: number; failed: number; cost: number; startedAt: number }
export const newStats = (): TurnStats => ({ reads: new Set(), edits: new Set(), commands: 0, failed: 0, cost: 0, startedAt: Date.now() });

export function summary(stats: TurnStats, ms: number): string {
  const parts = [
    stats.reads.size && `read ${stats.reads.size} file${stats.reads.size === 1 ? '' : 's'}`,
    stats.edits.size && `edited ${stats.edits.size} file${stats.edits.size === 1 ? '' : 's'}`,
    stats.commands && `ran ${stats.commands} command${stats.commands === 1 ? '' : 's'}`,
    stats.failed && `${stats.failed} failed`,
  ].filter(Boolean).join(', ');
  return [parts && parts[0]!.toUpperCase() + parts.slice(1), duration(ms), `~$${stats.cost.toFixed(4)}`].filter(Boolean).join(' · ');
}

// Inline spans. Code spans are split out first so nothing inside them is restyled.
// Underscore emphasis needs word boundaries (snake_case); asterisks need a non-space inside ("2 * 3").
function inline(text: string): string {
  const span = (input: string, mark: string, on: string, off: string) => input
    .replace(new RegExp(`(?<![\\\\*])\\*{${mark.length}}(?=\\S)(.+?)(?<=[^\\s\\\\])\\*{${mark.length}}(?!\\*)`, 'g'), `\x1b[${on}m$1\x1b[${off}m`)
    .replace(new RegExp(`(?<![\\w_\\\\])_{${mark.length}}(?=\\S)(.+?)(?<=[^\\s\\\\])_{${mark.length}}(?![\\w_])`, 'g'), `\x1b[${on}m$1\x1b[${off}m`);
  return text.split(/(`[^`]+`)/).map((part, i) => {
    if (i % 2) return `\x1b[36m${part.slice(1, -1)}\x1b[39m`;
    part = part.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, url) => `\x1b[4m${label}\x1b[24m \x1b[2m(${url.replace(/[*_~]/g, '\\$&')})\x1b[22m`);
    part = span(span(span(part, '***', '1;3', '22;23'), '**', '1', '22'), '*', '3', '23');
    return part.replace(/(?<!\\)~~(?=\S)(.+?)(?<=[^\s\\])~~/g, '\x1b[9m$1\x1b[29m').replace(/\\([*_~`\\[\]#>|-])/g, '$1');
  }).join('');
}

// Styles model markdown one completed line at a time; the only state is whether we are inside a code fence.
// Handles headings, emphasis, strikethrough, code, links, quotes, rules, bullets and table pipes.
// Not attempted: table column alignment, checkboxes, images, HTML, multi-line emphasis.
export function markdownStyler(color: boolean): (line: string) => string {
  let fence = false;
  if (!color) return line => line;
  const dim = (text: string) => `\x1b[2m${text}\x1b[22m`;
  return line => {
    if (/^\s*```/.test(line)) { fence = !fence; return dim(line); }
    if (fence) return `\x1b[36m${line}\x1b[0m`;
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) return `\x1b[1;33m${heading[1]!.replace(/\*\*|__|`/g, '')}\x1b[0m`;
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) return dim('─'.repeat(40));
    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) return `${dim('│')} \x1b[3m${inline(quote[1]!)}\x1b[23m`;
    if (/^\s*\|/.test(line)) {
      return /^[\s|:-]+$/.test(line) ? dim(line.replace(/\|/g, '│').replace(/[:-]/g, '─')) : inline(line).replace(/\|/g, dim('│'));
    }
    return inline(line.replace(/^(\s*)[-*+]\s+/, '$1• '));
  };
}
