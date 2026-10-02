# pith

A coding agent small enough to read in one sitting.

One model, six tools, one loop. About 1,600 lines of TypeScript on top of [pi-ai](https://www.npmjs.com/package/@earendil-works/pi-ai). It runs in a plain terminal: no TUI, no plugins, no server.

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

A turn stops after **20 model requests** or **512 KiB** of context. Nothing is summarised or pruned behind your back. For a fresh conversation, quit and relaunch.

### Six tools

| Tool | What it does |
|---|---|
| `read` | Numbered lines from a text file. 200 by default, 2,000 at most. |
| `write` | Creates or replaces a file, via a temporary file and a rename. |
| `edit` | One exact search and replace. Missing or ambiguous matches fail and change nothing. |
| `bash` | `/bin/bash -c` in the workspace. 30 s timeout by default, 120 s at most. |
| `search` | Web search. Titles, URLs and excerpts. No API key. |
| `fetch` | A web page as plain text, 20,000 characters at a time. |

File tools stay inside the workspace. Files are capped at **2 MiB** and tool results at **32 KiB**. When a command prints more than that, the middle is dropped and both ends are kept, since the error is usually at the bottom. Calls run one at a time.

### The model

[OpenRouter](https://openrouter.ai), `z-ai/glm-5.3-flash`, low reasoning. It's pinned: no fallback, no retries, no model switching. Costs shown are catalog estimates, not your bill.

### What you see

Each tool call is one dim row with a diamond: blinking while it runs, green when it works, red when it doesn't. Repeats of the same tool share a row. Edits show line counts instead of a diff.

Model text prints a line at a time with light markdown styling. Tables wait for their last row, then print with aligned columns. One too wide for the terminal prints each row as `Header: value` lines instead. A blank line separates it from the tool rows above and from the one-line summary that ends each turn.

The rest is your terminal. Scrollback, selection and search work as usual, because nothing redraws the screen. Typing during a run is ignored; Ctrl-C cancels it.

Full tool output isn't shown. It goes to a private log in `~/.local/state/pith/sessions/`, one JSONL file per launch. The API key is redacted there. Everything else isn't, so read a log before you share it.

## Is it safe?

Not by itself. **The shell tool runs commands with your permissions and no sandbox, and it is always on.** There is no read-only mode.

The path checks stop the file tools from wandering out of the workspace by accident. The shell isn't bound by them. It can read your home directory and reach the network. It doesn't inherit the API key, which limits exposure and isn't isolation.

Web pages are written by strangers, and the agent that reads them can also run commands. Everything `search` and `fetch` return is fenced and labelled as untrusted, and the model is told to treat it as data. That makes it harder for a page to hijack the agent. It doesn't make it impossible.

Searches go to [Exa](https://exa.ai)'s hosted endpoint, anonymously unless you give it a key. Apart from the model itself, it's the only service pith talks to on its own.

Use a disposable checkout or a container for anything you don't trust, and review `git diff`. pith never commits or pushes.

## Try it

macOS or Linux, Node 22.19+.

```bash
git clone https://github.com/avhagedorn/pith.git ~/dev/pith
cd ~/dev/pith
npm ci --ignore-scripts
npm run build
ln -s ~/dev/pith/pith ~/.local/bin/pith   # or any directory on your PATH
```

Then, from the repository you want to work on:

```bash
pith                          # interactive
pith "fix the failing test"   # one task, then exit
pith --check                  # check setup; no request, no cost
```

Keys go in `~/.config/pith/config.json`, and nowhere else:

```json
{
  "openrouterApiKey": "sk-or-...",
  "exaApiKey": "..."
}
```

The [OpenRouter](https://openrouter.ai) key is required. The [Exa](https://exa.ai) key is optional: search works without one, but anonymous use is rate limited. The file must be private (`chmod 600`), or pith refuses to start.

Ctrl-C at the prompt quits. There are no slash commands and no startup banner; `pith --check` shows the model, tools and config path.

If the workspace has an `AGENTS.md` at its root, it's added to the system prompt. That's where "use pnpm" and "run tests with X" go.

## What it doesn't do

Resume a session, compact context, sandbox anything, read images, run tools in parallel, switch models, or take plugins.

Checkboxes aren't rendered. Pages that need JavaScript come back mostly empty. Windows isn't supported.

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
  config.ts       the config file, its keys, and AGENTS.md
  session.ts      the audit log
  transcript.ts   progress events → what you see
  terminal.ts     all terminal output
  render.ts       tool rows and the turn summary
  markdown.ts     markdown styling and tables
  ansi.ts         escape codes, by name
  tools/          one folder per tool, plus shared file helpers
prompt.md         the whole system prompt
```
