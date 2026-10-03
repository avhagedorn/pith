#!/usr/bin/env node
import { readFile, realpath, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import type { Context } from '@earendil-works/pi-ai';
import * as ansi from './ansi.js';
import {
  CONFIG_PATH,
  INSTRUCTIONS_FILE,
  loadConfig,
  projectInstructions,
  redact,
} from './config.js';
import { errorCode, errorText } from './errors.js';
import { runTurn, type RunOutcome } from './loop.js';
import { createModel } from './model.js';
import { openSessionLog } from './session.js';
import { createTerminal, terminalText } from './terminal.js';
import { createTools } from './tools/index.js';
import { createTranscript } from './transcript.js';

const MAX_PROMPT_BYTES = 64 * 1024;
const PROMPT_TOO_LONG = 'Prompt exceeds 64 KiB.';
const PROMPT_MARK = '❯ ';
const UNSANDBOXED_NOTE = 'Execution mode: local tools enabled; bash is unsandboxed.';
const BASE_PROMPT_FILE = new URL('../../prompt.md', import.meta.url);
const EXIT_CODE: Record<RunOutcome['reason'], number> = {
  complete: 0,
  aborted: 130, // what a shell reports for a process ended by Ctrl-C
  limit: 1,
  error: 1,
};
const HELP = `pith — a plain-terminal coding agent

Usage: pith [--cwd PATH] ["task"]
       printf 'task' | pith --cwd PATH

  --cwd PATH  Workspace (default: current directory)
  --check     Check local model/config setup; no API request or billing
  --help      Show this help

Config: ~/.config/pith/config.json (keys, model, reasoning; see README)
Ctrl-C cancels a run, or quits at the prompt. Each launch is a new conversation.
Logs: ~/.local/state/pith/sessions/ (private JSONL; no disk resume yet)

The tools (read, write, edit, bash) run with your OS permissions. bash is NOT sandboxed.
Use a disposable checkout/container and review git diff. No plugins, TUI or discovery.
`;

// Set when whatever reads our stdout goes away, so a run in progress stops too.
const outputClosed = new AbortController();

async function readPipedPrompt(): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_PROMPT_BYTES) throw new Error(PROMPT_TOO_LONG);
    chunks.push(buffer);
  }
  const prompt = Buffer.concat(chunks).toString('utf8').trim();
  if (!prompt) {
    throw new Error('No prompt provided. Run in a terminal, pass a task, or pipe text on stdin.');
  }
  return prompt;
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      cwd: { type: 'string' },
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
  const config = await loadConfig();
  const { openrouterApiKey, model, exaApiKey, reasoning } = config;
  const secrets = [openrouterApiKey, exaApiKey];
  const tools = await createTools(cwd, exaApiKey);
  const toolNames = tools.definitions.map(tool => tool.name).join(', ');

  let activeTurn: AbortController | undefined;
  const interrupt = () => activeTurn?.abort();
  const term = createTerminal(text => terminalText(redact(text, secrets)), interrupt);

  if (values.check) {
    createModel(config, 'setup-check'); // throws if the model is unknown
    term.status(`model: ${model} (reasoning ${reasoning})\nworkspace: ${cwd}\ntools: ${toolNames}`);
    term.status(`search: Exa, ${exaApiKey ? 'with your key' : 'anonymous (rate limited)'}`);
    term.status(`config: ${CONFIG_PATH}`);
    term.status('local setup ready — no API request made; remote key validity not checked');
    return;
  }

  // A task on the command line or on stdin runs once and exits. Otherwise we prompt.
  const interactive = Boolean(process.stdin.isTTY && !positionals.length);
  const task = positionals.join(' ').trim() || (interactive ? '' : await readPipedPrompt());

  const basePrompt = (await readFile(BASE_PROMPT_FILE, 'utf8')).trim();
  const instructions = await projectInstructions(cwd);
  const systemPrompt = [
    `${basePrompt}\n\nWorkspace: ${cwd}\n${UNSANDBOXED_NOTE}`,
    instructions && `Project instructions from ${INSTRUCTIONS_FILE}:\n\n${instructions}`,
  ]
    .filter(Boolean)
    .join('\n\n');
  const context: Context = { systemPrompt, tools: tools.definitions, messages: [] };
  const log = await openSessionLog(
    {
      cwd,
      model,
      reasoning,
      systemPrompt,
      tools: tools.definitions,
    },
    secrets,
  );
  const generate = createModel(config, log.id);
  const transcript = createTranscript(term);

  // A fresh readline per question: none exists while the agent runs, so nothing echoes typing.
  const history: string[] = [];
  async function ask(): Promise<string | undefined> {
    const readline = createInterface({
      input: process.stdin,
      output: process.stdout,
      history,
      removeHistoryDuplicates: true,
    });
    const closed = new AbortController();
    readline.once('SIGINT', () => closed.abort());
    readline.once('close', () => closed.abort());
    readline.on('history', entries => {
      history.splice(0, history.length, ...entries);
    });
    const signal = AbortSignal.any([closed.signal, outputClosed.signal]);

    // The color is left open so typed text shares it, and closed once the line is in.
    const tint = term.styled ? ansi.BOLD_CYAN : '';
    try {
      return await readline.question(`\n${tint}${PROMPT_MARK}`, { signal });
    } catch (error) {
      if (signal.aborted) return undefined;
      throw error;
    } finally {
      readline.close();
      if (tint) process.stdout.write(ansi.RESET);
    }
  }

  async function runPrompt(prompt: string): Promise<RunOutcome> {
    if (Buffer.byteLength(prompt) > MAX_PROMPT_BYTES) throw new Error(PROMPT_TOO_LONG);
    activeTurn = new AbortController();
    term.busy(true);
    if (interactive) term.blankLine();
    transcript.begin();
    const outcome = await runTurn({
      prompt,
      context,
      generate,
      tools,
      record: log.record,
      onProgress: transcript.onProgress,
      signal: AbortSignal.any([activeTurn.signal, outputClosed.signal]),
    });
    activeTurn = undefined;
    transcript.end(outcome);
    term.busy(false);
    return outcome;
  }

  process.on('SIGINT', interrupt);
  try {
    if (!interactive) {
      process.exitCode = EXIT_CODE[(await runPrompt(task)).reason];
      return;
    }

    // Ctrl-C or Ctrl-D at the prompt quits. A new conversation is a new launch.
    while (!outputClosed.signal.aborted) {
      const prompt = (await ask())?.trim();
      if (prompt === undefined) break;
      if (prompt) await runPrompt(prompt);
    }
  } finally {
    process.removeListener('SIGINT', interrupt);
    await log.close();
  }
}

// A closed pipe is normal when the reader exits early (`pith ... | head`).
process.stdout.on('error', error => {
  if (errorCode(error) !== 'EPIPE') throw error;
  outputClosed.abort();
  process.exitCode = 1;
});

main().catch(error => {
  // Only local setup and storage errors land here, and those never contain an API key.
  process.stderr.write(`pith: ${terminalText(errorText(error))}\n`);
  process.exitCode = 1;
});
