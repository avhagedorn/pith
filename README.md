# pith

A coding agent small enough to read in one sitting.

One model, four tools, one loop. About 1,300 lines of TypeScript on top of [pi-ai](https://www.npmjs.com/package/@earendil-works/pi-ai). It runs in a plain terminal: no TUI, no plugins, no server.

```text
❯ fix the add bug

◆ 2× read test.mjs {4 lines}
◆ $ node test.mjs {exit 1}
◆ edit add.mjs {+1/-1}
◆ $ node test.mjs {PASS}
add.mjs used a - b instead of a + b. Fixed, and the test passes.
── Read 2 files, edited 1 file, ran 2 commands, 1 failed · 5s · ~$0.0004 ──────
```

## How it works

### The loop

Ask the model. Run the tools it asks for. Repeat until it answers in text.

Only a complete response can run tools. Every tool call gets a result, even if you cancel halfway. That's most of [`loop.ts`](src/loop.ts).

A turn stops after **20 model requests** or **512 KiB** of context. Nothing is summarised or pruned behind your back; `/new` starts fresh.

### Four tools

| Tool | What it does |
|---|---|
| `read` | Numbered lines from a text file. 200 by default, 2,000 at most. |
| `write` | Creates or replaces a file, via a temporary file and a rename. |
| `edit` | One exact search and replace. Missing or ambiguous matches fail and change nothing. |
| `bash` | `/bin/bash -c` in the workspace. 30 s timeout by default, 120 s at most. |

File tools stay inside the workspace. Files are capped at **2 MiB** and tool results at **32 KiB**. Calls run one at a time.

Without `--allow-local-tools` you only get `read`.

### The model

[OpenRouter](https://openrouter.ai), `z-ai/glm-5.3-flash`, low reasoning. It's pinned: no fallback, no retries, no model switching. Costs shown are catalog estimates, not your bill.

### What you see

Each tool call is one dim row with a diamond: grey while running, green when it works, red when it doesn't. Repeats of the same tool share a row. Edits show line counts instead of a diff.

Model text prints a line at a time with light markdown styling. Each turn ends with a one-line summary.

The rest is your terminal. Scrollback, selection and search work as usual, because nothing redraws the screen. Typing during a run is ignored; Ctrl-C cancels it.

Full tool output isn't shown. It goes to a private log in `~/.local/state/pith/sessions/`, one JSONL file per launch. The API key is redacted there. Everything else isn't, so read a log before you share it.

## Is it safe?

Not by itself. **`--allow-local-tools` runs shell commands with your permissions and no sandbox.**

The path checks stop the file tools from wandering out of the workspace by accident. The shell isn't bound by them. It can read your home directory and reach the network. It doesn't inherit the API key, which limits exposure and isn't isolation.

Use a disposable checkout or a container for anything you don't trust, and review `git diff`. pith never commits or pushes.

## Try it

macOS or Linux, Node 22.19+.

```bash
git clone https://github.com/avhagedorn/pith.git ~/dev/pith
cd ~/dev/pith
npm ci --ignore-scripts
npm run build
```

Then, from the repository you want to work on:

```bash
~/dev/pith/pith --allow-local-tools                          # interactive
~/dev/pith/pith --allow-local-tools "fix the failing test"   # one task, then exit
~/dev/pith/pith --check                                      # check setup; no request, no cost
```

It needs an OpenRouter key: `OPENROUTER_API_KEY`, or the one [Pi](https://pi.dev) already saved in `~/.pi/agent/auth.json`. Pi's file is read, never written.

`/new` clears the conversation. `/exit` quits.

## What it doesn't do

Resume a session, compact context, sandbox anything, read images, run tools in parallel, switch models, load project instructions, or take plugins.

Tables aren't aligned and checkboxes aren't rendered. Windows isn't supported.

## Development

```bash
npm test          # build, then the offline tests; no API key needed
npm run format    # Biome
```

Tests use scripted model responses, so they cost nothing. CI runs the format check and the tests on every push.

```text
src/
  cli.ts          arguments, setup and the prompt loop
  loop.ts         the agent loop
  model.ts        the pinned model
  auth.ts         finding the API key
  session.ts      the audit log
  transcript.ts   progress events → what you see
  terminal.ts     all terminal output
  render.ts       tool rows, summary and markdown styling
  ansi.ts         escape codes, by name
  tools/          one folder per tool, plus shared file helpers
prompt.md         the whole system prompt
```
