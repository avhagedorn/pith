import type { ToolCall } from '@earendil-works/pi-ai';
import type { Notice, RunOutcome } from './loop.js';
import { detail, markdownStyler, newStats, preview, rule, summary } from './render.js';
import type { Terminal } from './terminal.js';
import type { ToolOutput } from './tools/index.js';

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
  let style = markdownStyler(term.styled);
  let pending = ''; // text received since the last newline
  let said = false; // this response has printed text
  let gapOwed = false; // a blank line is due before the next text
  let stats = newStats();
  let toolStartedAt = 0;
  let burst: Burst | undefined; // consecutive successes of one tool, sharing a row

  // Blank lines are held back: dropped at either end of a response, collapsed in the middle.
  const say = (line: string) => {
    if (!line.trim()) {
      gapOwed = said;
      return;
    }
    burst = undefined;
    term.text(`${gapOwed ? '\n' : ''}${style(term.clean(line))}`);
    said = true;
    gapOwed = false;
  };

  const endText = () => {
    say(pending);
    pending = '';
    said = gapOwed = false;
    style = markdownStyler(term.styled); // an unclosed code fence must not leak onward
  };

  const toolEnded = (call: ToolCall, result: ToolOutput) => {
    const ms = toolStartedAt ? Date.now() - toolStartedAt : 0;
    toolStartedAt = 0;

    if (call.name === 'bash') stats.commands++;
    else (call.name === 'read' ? stats.reads : stats.edits).add(String(call.arguments?.path));
    if (result.isError) stats.failed++;

    // A failure never joins a burst, so it always keeps a row of its own.
    const joinable = term.canRedraw && !result.isError && burst?.name === call.name;
    const joined = joinable ? burst : undefined;
    burst = result.isError
      ? undefined
      : { name: call.name, count: (joined?.count ?? 0) + 1, ms: (joined?.ms ?? 0) + ms };

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
          term.row(`${preview(notice.call)} {running}`, 'run', 'transient');
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
      if (outcome.reason !== 'complete') term.status(`[${outcome.reason}] ${outcome.detail}`);
      term.status(rule(summary(stats, Date.now() - stats.startedAt), term.width()), true);
    },
  };
}
