#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile, realpath, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import type { Context } from '@earendil-works/pi-ai';
import { resolveKey } from './auth.js';
import { createModel, MODEL_ID } from './model.js';
import { createTools } from './tools.js';
import { SessionLog } from './session.js';
import { runTurn, type Notice } from './loop.js';
import { detail, markdownStyler, newStats, preview, row, summary } from './render.js';

const outputClosed = new AbortController();
const HELP = `pith — a plain-terminal coding agent

Usage: pith [--cwd PATH] [--allow-local-tools] ["task"]
       printf 'task' | pith --cwd PATH

  --cwd PATH           Workspace (default: current directory)
  --allow-local-tools  Enable write, edit and UNSANDBOXED bash (read is always available)
  --check              Check local model/auth setup; no API request or billing
  --help               Show this help

Model: openrouter / ${MODEL_ID} (fixed; no model fallback)
Auth: OPENROUTER_API_KEY, then Pi's saved OpenRouter API-key credential (read-only)
Interactive: /new clears context, /exit quits, Ctrl-C cancels a run.
Logs: ~/.local/state/pith/sessions/ (private JSONL; no disk resume yet)

Local tools have your OS permissions. cwd/path checks are NOT a shell sandbox.
Use a disposable checkout/container and review git diff. No plugins, TUI or discovery.
`;

// Never interpret terminal control sequences from model/tool output.
export function terminalText(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      cwd: { type: 'string' },
      'allow-local-tools': { type: 'boolean', default: false },
      check: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    process.stdout.write(HELP);
    return;
  }
  const cwd = await realpath(values.cwd || process.cwd());
  if (!(await stat(cwd)).isDirectory()) throw new Error('Workspace must be a directory.');
  const auth = await resolveKey();
  const clean = (text: string) => terminalText(text.replaceAll(auth.key, '[REDACTED]'));
  // The only cursor control: redraw the current line, or (for bursts) the tool row just above it.
  const tty = Boolean(process.stderr.isTTY);
  const color = tty && !process.env.NO_COLOR;
  const wipe = tty ? '\r\x1b[K' : '';
  // Hidden while the agent runs, so a visible cursor always means "your turn".
  const cursor = (show: boolean) => {
    if (tty) process.stderr.write(show ? '\x1b[?25h' : '\x1b[?25l');
  };
  process.on('exit', () => cursor(true));
  const status = (text: string, dim = false) =>
    process.stderr.write(`${wipe}${dim && color ? `\x1b[2m${clean(text)}\x1b[0m` : clean(text)}\n`);
  const width = () => Math.min(process.stderr.columns || 100, 110);
  const paint = (text: string, state: 'run' | 'ok' | 'error', transient = false) => {
    if (transient && !tty) return;
    process.stderr.write(wipe + row(clean(text), state, color, width()) + (transient ? '' : '\n'));
  };
  const allowLocalTools = values['allow-local-tools'];
  const tools = await createTools(cwd, allowLocalTools);
  // Resolve the pinned catalog before starting a session or requesting tokens.
  createModel(auth.key, 'setup-check');
  if (values.check) {
    status(
      `model: ${MODEL_ID}\nauth: ${auth.source}\nworkspace: ${cwd}\ntools: ${tools.definitions.map(t => t.name).join(', ')}\nlocal setup ready — no API request made; remote key validity not checked`,
    );
    return;
  }

  const interactive = Boolean(process.stdin.isTTY && !positionals.length);
  let initial = positionals.join(' ').trim();
  if (!initial && !interactive) {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of process.stdin) {
      const buffer = Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > 64 * 1024) throw new Error('Prompt exceeds 64 KiB.');
      chunks.push(buffer);
    }
    initial = Buffer.concat(chunks).toString('utf8').trim();
    if (!initial) throw new Error('No prompt provided. Run in a terminal, pass a task, or pipe text on stdin.');
  }
  const basePrompt = (await readFile(new URL('../../prompt.md', import.meta.url), 'utf8')).trim();
  const systemPrompt = `${basePrompt}\n\nWorkspace: ${cwd}\nExecution mode: ${allowLocalTools ? 'local tools enabled; bash is unsandboxed' : 'read-only; only read is enabled'}.`;
  const context: Context = { systemPrompt, tools: tools.definitions, messages: [] };
  const log = await SessionLog.create(
    { cwd, model: MODEL_ID, reasoning: 'low', systemPrompt, tools: tools.definitions, allowLocalTools },
    auth.key,
  );
  const generate = createModel(auth.key, log.id);
  let active: AbortController | undefined;
  const interrupt = () => active?.abort();
  process.on('SIGINT', interrupt);
  // While a run is active, swallow keystrokes so terminal echo cannot corrupt the redrawn rows
  // or leak into the next prompt. Raw mode also turns off the tty's own Ctrl-C, so forward it.
  const swallow = (data: Buffer) => {
    if (data.includes(3)) interrupt();
  };
  const mute = (on: boolean) => {
    if (!process.stdin.isTTY) return;
    process.stdin.setRawMode(on);
    if (on) process.stdin.on('data', swallow).resume();
    else process.stdin.off('data', swallow).pause();
  };
  process.on('exit', () => {
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
  });
  const history: string[] = [];

  async function ask(): Promise<string | undefined> {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      history,
      removeHistoryDuplicates: true,
    });
    const controller = new AbortController();
    rl.once('SIGINT', () => controller.abort());
    rl.once('close', () => controller.abort());
    rl.on('history', entries => {
      history.splice(0, history.length, ...entries);
    });
    const signal = AbortSignal.any([controller.signal, outputClosed.signal]);
    // The colour is left open so the typed text shares it; closed once the line is submitted.
    const tint = color && process.stdout.isTTY;
    try {
      return await rl.question(tint ? '\n\x1b[1;36m❯ ' : '\n❯ ', { signal });
    } catch (error) {
      if (signal.aborted) return undefined;
      throw error;
    } finally {
      rl.close();
      if (tint) process.stdout.write('\x1b[0m');
    }
  }

  // Model text is printed one completed line at a time, so each line can be styled without ever redrawing.
  const styled = color && Boolean(process.stdout.isTTY);
  let style = markdownStyler(styled);
  let pending = '';
  let said = false; // anything printed for this response yet
  let gap = false; // a blank line is owed before the next line of text
  let stats = newStats();
  let started = 0;
  let burst: { name: string; count: number; ms: number } | undefined; // consecutive successes of one tool share a row
  const say = (line: string) => {
    // Leading/trailing blank lines are dropped (providers emit blank text before tool-only turns); runs collapse to one.
    if (!line.trim()) {
      gap = said;
      return;
    }
    burst = undefined;
    process.stderr.write(wipe);
    process.stdout.write(`${gap ? '\n' : ''}${style(clean(line))}\n`);
    said = true;
    gap = false;
  };
  const endText = () => {
    say(pending);
    pending = '';
    said = gap = false;
    style = markdownStyler(styled);
  };
  const notify = (notice: Notice) => {
    switch (notice.type) {
      case 'request':
        endText();
        paint('thinking', 'run', true);
        break;
      case 'text': {
        const lines = (pending + notice.text).split('\n');
        pending = lines.pop()!;
        lines.forEach(say);
        break;
      }
      case 'tool-start':
        endText();
        started = Date.now();
        paint(`${preview(notice.call)} {running}`, 'run', true);
        break;
      case 'tool-end': {
        const { call, result } = notice;
        const ms = started ? Date.now() - started : 0;
        started = 0;
        if (call.name === 'bash') stats.commands++;
        else (call.name === 'read' ? stats.reads : stats.edits).add(String(call.arguments?.path));
        if (result.isError) stats.failed++;
        // A failure always keeps its own row and ends the burst.
        const previous = tty && !result.isError && burst?.name === call.name ? burst : undefined;
        burst = result.isError
          ? undefined
          : { name: call.name, count: (previous?.count ?? 0) + 1, ms: (previous?.ms ?? 0) + ms };
        if (previous) process.stderr.write(`${wipe}\x1b[1A`);
        const info = detail(call, result, burst?.ms ?? ms);
        paint(
          `${previous ? `${burst!.count}× ` : ''}${preview(call)}${info ? ` {${info}}` : ''}`,
          result.isError ? 'error' : 'ok',
        );
        break;
      }
      case 'usage':
        stats.cost += notice.usage.cost.total;
    }
  };
  try {
    status(`pith · ${MODEL_ID}\nworkspace: ${cwd}\nauth: ${auth.source}\nsession: ${log.path}`);
    status(
      allowLocalTools
        ? 'LOCAL TOOLS ENABLED — bash is unsandboxed. Review changes.'
        : 'read-only — add --allow-local-tools to enable write/edit/bash.',
    );
    if (interactive) status('/new · /exit · Ctrl-C to cancel; wait for the prompt before typing.');
    let prompt: string | undefined = interactive ? await ask() : initial;
    while (prompt !== undefined) {
      prompt = prompt.trim();
      if (interactive && prompt === '/exit') break;
      if (interactive && prompt === '/new') {
        await log.record({ type: 'context_reset' });
        context.messages = [];
        status('context cleared; earlier messages remain in the audit log.');
      } else if (prompt) {
        if (Buffer.byteLength(prompt) > 64 * 1024) throw new Error('Prompt exceeds 64 KiB.');
        active = new AbortController();
        cursor(false);
        mute(true);
        if (interactive) process.stderr.write('\n');
        stats = newStats();
        burst = undefined;
        const result = await runTurn({
          prompt,
          context,
          generate,
          tools,
          record: log.record,
          notify,
          signal: AbortSignal.any([active.signal, outputClosed.signal]),
        });
        active = undefined;
        endText();
        cursor(true);
        mute(false);
        if (result.reason !== 'complete') status(`[${result.reason}] ${result.detail}`);
        status(`── ${summary(stats, Date.now() - stats.startedAt)} `.padEnd(width(), '─'), true);
        if (!interactive) process.exitCode = result.reason === 'complete' ? 0 : result.reason === 'aborted' ? 130 : 1;
      }
      if (!interactive || outputClosed.signal.aborted) break;
      prompt = await ask();
    }
  } finally {
    process.removeListener('SIGINT', interrupt);
    await log.close();
  }
}

// A closed output pipe is normal when a consumer exits early.
process.stdout.on('error', error => {
  if ((error as NodeJS.ErrnoException).code === 'EPIPE') {
    outputClosed.abort();
    process.exitCode = 1;
  } else throw error;
});
main().catch(error => {
  // Errors here are local setup/storage errors. Provider errors go through the redacting renderer.
  process.stderr.write(`pith: ${terminalText(error instanceof Error ? error.message : String(error))}\n`);
  process.exitCode = 1;
});
