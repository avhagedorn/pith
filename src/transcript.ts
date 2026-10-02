import type { ToolCall } from '@earendil-works/pi-ai';
import type { Notice, RunOutcome } from './loop.js';
import { markdownStyler } from './markdown.js';
import { detail, newStats, preview, rule, summary } from './render.js';
import type { Terminal } from './terminal.js';
import type { ToolOutput } from './tools/index.js';

const WEB_TOOLS = new Set(['search', 'fetch']);

interface Burst {
  name: string;
  count: number;
  ms: number;
}

/**
 * Turns the loop's progress notices into what the user sees: one row per tool call, model text
 * a finished line at a time, and a summary rule when the turn ends.
 */
export function createTranscript(term: Terminal) {
  let style = markdownStyler(term.styled, term.width);
  let pending = ''; // text received since the last newline
  let said = false; // this response has printed text
  let gapOwed = false; // a blank line is due before the next text
  let stats = newStats();
  let toolStartedAt = 0;
  let burst: Burst | undefined; // consecutive successes of one tool, sharing a row
  let rowsAbove = false; // tool rows sit directly above, so text needs a blank line first
  let shownAnything = false; // this turn has output, so the summary needs a blank line first

  const print = (styledLine: string) => {
    burst = undefined;
    if (rowsAbove) term.status('');
    rowsAbove = false;
    shownAnything = true;
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

  const toolEnded = (call: ToolCall, result: ToolOutput) => {
    const ms = toolStartedAt ? Date.now() - toolStartedAt : 0;
    toolStartedAt = 0;

    const path = String(call.arguments?.path);
    if (call.name === 'bash') stats.commands++;
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
    begin() {
      stats = newStats();
      burst = undefined;
      rowsAbove = shownAnything = false;
    },

    onProgress(notice: Notice) {
      switch (notice.type) {
        case 'request':
          endText();
          term.row('thinking', 'run', 'transient');
          break;
        case 'text': {
          const lines = (pending + notice.text).split('\n');
          pending = lines.pop()!;
          lines.forEach(say);
          break;
        }
        case 'tool-start':
          endText();
          toolStartedAt = Date.now();
          term.row(preview(notice.call), 'run', 'transient');
          break;
        case 'tool-end':
          toolEnded(notice.call, notice.result);
          break;
        case 'usage':
          stats.cost += notice.usage.cost.total;
      }
    },

    end(outcome: RunOutcome) {
      endText();
      if (shownAnything) term.status('');
      if (outcome.reason !== 'complete') term.status(`[${outcome.reason}] ${outcome.detail}`);
      term.status(rule(summary(stats, Date.now() - stats.startedAt), term.width()), true);
    },
  };
}
