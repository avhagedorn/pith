import type { Message, ToolCall } from '@earendil-works/pi-ai';
import { MAX_CONTEXT_BYTES, type Notice, type RunOutcome } from './loop.js';
import { markdownStyler } from './markdown.js';
import { contextUse, detail, duration, newStats, preview, rule, summary } from './render.js';
import type { Terminal } from './terminal.js';
import type { ToolOutput } from './tools/index.js';

const WEB_TOOLS = new Set(['search', 'fetch']);
// PITH_PROFILE=1 prints how each model request spent its time.
const PROFILE = Boolean(process.env.PITH_PROFILE);

type Phase = 'thinking' | 'text' | 'tool-call';
interface Timing {
  start: number;
  end: number;
  size: number;
}

interface Burst {
  name: string;
  count: number;
  ms: number;
}

/**
 * Turns the loop's progress notices into what the user sees: one row per tool call, model text
 * a finished line at a time, and a summary rule when the turn ends.
 */
export function createTranscript(term: Terminal, contextWindow = Infinity) {
  let style = markdownStyler(term.styled, term.width);
  let pending = ''; // text received since the last newline
  let said = false; // this response has printed text
  let gapOwed = false; // a blank line is due before the next text
  let stats = newStats();
  let toolStartedAt = 0;
  let contextTokens = 0; // as of the latest model response
  let burst: Burst | undefined; // consecutive successes of one tool, sharing a row
  let rowsAbove = false; // tool rows sit directly above, so text needs a blank line first
  let textAbove = false; // text sits directly above, so rows need a blank line first
  let shownAnything = false; // this turn has output, so the summary needs a blank line first
  let phase: Phase | 'waiting' | undefined; // what the model is doing, shown while it streams
  let requestStart = 0;
  let requestNumber = 0;
  let firstByte = 0;
  let timings: Partial<Record<Phase, Timing>> = {};

  // Only the phase the model is actually in gets a row: waiting, thinking, or writing a call.
  const showPhase = (next: Phase | 'waiting', tool?: string) => {
    if (next === phase) return;
    phase = next;
    if (next === 'waiting') term.row('waiting for model', 'run', 'transient');
    if (next === 'thinking') term.row('thinking', 'run', 'transient');
    if (next === 'tool-call') term.row(`writing ${tool ?? 'a tool'} call`, 'run', 'transient');
  };

  const track = (kind: Phase, size: number) => {
    const now = Date.now();
    firstByte ||= now;
    const timing = (timings[kind] ??= { start: now, end: now, size: 0 });
    timing.end = now;
    timing.size += size;
  };

  const profileLine = (input: number, output: number) => {
    const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
    const parts = [`request ${requestNumber}`];
    if (firstByte) parts.push(`first byte ${seconds(firstByte - requestStart)}`);
    for (const kind of ['thinking', 'tool-call', 'text'] as const) {
      const timing = timings[kind];
      if (timing)
        parts.push(`${kind} ${seconds(timing.end - timing.start)} (${timing.size} chars)`);
    }
    parts.push(`total ${seconds(Date.now() - requestStart)}`, `${input} in / ${output} out tokens`);
    term.status(`  ${parts.join(' · ')}`, true);
  };

  const print = (styledLine: string) => {
    burst = undefined;
    if (rowsAbove) term.status('');
    rowsAbove = false;
    textAbove = shownAnything = true;
    term.text(`${gapOwed ? '\n' : ''}${styledLine}`);
    said = true;
    gapOwed = false;
  };

  // Blank lines are held back: dropped at either end of a response, collapsed in the middle.
  const say = (line: string) => {
    if (line.trim()) {
      style.push(term.clean(line)).forEach(print);
      return;
    }
    style.flush().forEach(print); // a blank line ends a table
    gapOwed = said;
  };

  const endText = () => {
    say(pending);
    style.flush().forEach(print);
    pending = '';
    said = gapOwed = false;
    style = markdownStyler(term.styled, term.width); // an unclosed code fence must not leak onward
  };

  const breakAfterText = () => {
    if (textAbove) term.status('');
    textAbove = false;
  };

  const toolEnded = (call: ToolCall, result: ToolOutput) => {
    breakAfterText();
    const ms = toolStartedAt ? Date.now() - toolStartedAt : 0;
    toolStartedAt = 0;

    const path = String(call.arguments?.path);
    if (call.name === 'bash') stats.commands++;
    else if (call.name === 'background')
      stats.commands += call.arguments?.action === 'start' ? 1 : 0;
    else if (call.name === 'read') stats.reads.add(path);
    else if (WEB_TOOLS.has(call.name)) stats.lookups++;
    else stats.edits.add(path);
    if (result.isError) stats.failed++;

    // A failure never joins a burst, so it always keeps a row of its own.
    const joinable = term.canRedraw && !result.isError && burst?.name === call.name;
    const joined = joinable ? burst : undefined;
    burst = result.isError
      ? undefined
      : { name: call.name, count: (joined?.count ?? 0) + 1, ms: (joined?.ms ?? 0) + ms };

    rowsAbove = shownAnything = true;
    const times = joined ? `${burst!.count}× ` : '';
    const info = detail(call, result, burst?.ms ?? ms);
    term.row(
      `${times}${preview(call)}${info ? ` {${info}}` : ''}`,
      result.isError ? 'error' : 'ok',
      joined ? 'replace-previous' : 'keep',
    );
  };

  return {
    // Prints an earlier conversation roughly as it looked live: prompts, tool rows and answers.
    replay(messages: Message[]) {
      const calls = new Map<string, ToolCall>();
      for (const message of messages) {
        if (message.role === 'user') {
          endText();
          const blocks = typeof message.content === 'string' ? [message.content] : message.content;
          term.pastPrompt(
            blocks
              .map(block =>
                typeof block === 'string' ? block : block.type === 'text' ? block.text : '',
              )
              .join(''),
          );
          burst = undefined;
          rowsAbove = textAbove = false;
        } else if (message.role === 'assistant') {
          for (const block of message.content) {
            if (block.type === 'text') block.text.split('\n').forEach(say);
            if (block.type === 'toolCall') calls.set(block.id, block);
          }
          endText();
        } else if (message.role === 'toolResult') {
          const call = calls.get(message.toolCallId);
          const text = message.content
            .map(part => (part.type === 'text' ? part.text : ''))
            .join('');
          if (call) toolEnded(call, { text, isError: message.isError });
        }
      }
      endText();
    },

    begin() {
      requestNumber = 0;
      stats = newStats();
      burst = undefined;
      rowsAbove = textAbove = shownAnything = false;
    },

    onProgress(notice: Notice) {
      switch (notice.type) {
        case 'request':
          endText();
          phase = undefined;
          requestNumber = notice.step;
          requestStart = Date.now();
          firstByte = 0;
          timings = {};
          breakAfterText();
          showPhase('waiting');
          break;
        case 'thinking':
        case 'tool-call':
          track(notice.type, notice.size);
          showPhase(notice.type, notice.type === 'tool-call' ? notice.tool : undefined);
          break;
        case 'text': {
          track('text', notice.text.length);
          phase = 'text';
          const lines = (pending + notice.text).split('\n');
          pending = lines.pop()!;
          lines.forEach(say);
          break;
        }
        case 'tool-start':
          endText();
          breakAfterText();
          toolStartedAt = Date.now();
          term.row(preview(notice.call), 'run', 'transient');
          break;
        case 'tool-end':
          toolEnded(notice.call, notice.result);
          break;
        case 'inbox':
          endText();
          breakAfterText();
          burst = undefined;
          rowsAbove = shownAnything = true;
          for (const text of notice.notices) term.row(text.split('\n')[0]!, 'wait');
          break;
        case 'usage':
          stats.cost += notice.usage.cost.total;
          contextTokens =
            notice.usage.input +
            notice.usage.cacheRead +
            notice.usage.cacheWrite +
            notice.usage.output;
          if (PROFILE) {
            endText();
            profileLine(notice.usage.input + notice.usage.cacheRead, notice.usage.output);
          }
      }
    },

    // `contextBytes` is the conversation's size now; pith stops at MAX_CONTEXT_BYTES.
    end(outcome: RunOutcome, contextBytes = 0) {
      endText();
      if (shownAnything) term.status('');
      textAbove = false;
      if (outcome.reason !== 'complete') term.status(`[${outcome.reason}] ${outcome.detail}`);
      const fill = Math.max(contextBytes / MAX_CONTEXT_BYTES, contextTokens / contextWindow);
      const context = contextTokens ? contextUse(contextTokens, fill) : '';
      term.status(rule(summary(stats, Date.now() - stats.startedAt, context), term.width()), true);
    },
  };
}
