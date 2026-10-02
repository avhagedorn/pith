# pith

A small coding agent for your terminal.

It asks a model what to do, runs the tools the model asks for, and keeps going until it has an answer. That's the whole thing: about **1,600 lines** of TypeScript, six tools, no TUI.

```text
❯ fix the add bug

◆ 2× read test.mjs {4 lines}
◆ $ node test.mjs {exit 1}
◆ edit add.mjs {+1/-1}
◆ $ node test.mjs {PASS}

add.mjs used a - b instead of a + b. Fixed, and the test passes.

── Read 2 files, edited 1 file, ran 2 commands, 1 failed · 5s · ~$0.0004 ──────
```

## Try it

macOS or Linux, Node 22.19+.

```bash
git clone https://github.com/avhagedorn/pith.git
cd pith
npm install
npm link
```

That builds it and puts `pith` on your PATH.

Then tell it which model to use. Create `~/.config/pith/config.json`:

```json
{
  "openrouterApiKey": "sk-or-...",
  "model": "an OpenRouter model id"
}
```

```bash
chmod 600 ~/.config/pith/config.json
```

The model can be anything on [OpenRouter](https://openrouter.ai) that supports tool calls. pith won't start if other users can read the file.

Those two are required. The rest is optional:

| Setting | Default | What it does |
|---|---|---|
| `exaApiKey` | none | An [Exa](https://exa.ai) key for web search. Search works without one, but you'll hit rate limits. |
| `reasoning` | `"low"` | How hard the model thinks: `minimal`, `low`, `medium`, `high`, `xhigh` or `max`. |
| `maxOutputTokens` | `8192` | The most one model response can be. |
| `maxSteps` | `20` | How many times the model can be called in one turn. |

Now go to a repo and run it:

```bash
pith                          # chat
pith "fix the failing test"   # one task, then exit
pith --check                  # show the setup without spending anything
```

Ctrl-C cancels a run. At the prompt, it quits.

If the repo has an `AGENTS.md` at its root, pith reads it. That's where "use pnpm" and "run tests with X" go.

## How it works

### The loop

Ask the model. Run the tools it asks for. Repeat until it answers in text. That's most of [`loop.ts`](src/loop.ts).

A turn stops after **20 model requests** (`maxSteps`) or **512 KiB** of context. Nothing gets summarised or dropped along the way. Want a fresh conversation? Quit and run it again.

### Six tools

| Tool | What it does |
|---|---|
| `read` | Numbered lines from a text file. |
| `write` | Creates or replaces a file. |
| `edit` | One exact search and replace. If the match is missing or ambiguous, nothing changes. |
| `bash` | Runs a command in the repo, with your permissions. No sandbox. |
| `search` | Web search: titles, URLs and excerpts. |
| `fetch` | A web page as plain text. |

File tools stay inside the repo. Tool results are capped at **32 KiB**. When a command prints more than that, the middle is dropped and both ends are kept, because the error is usually at the bottom.

Anything from the web is marked as untrusted before the model sees it.

### What you see

Each tool call is one dim row with a diamond. It blinks while it runs, then turns green or red. Repeats of the same tool share a row, and edits show line counts instead of a diff.

Answers print a line at a time with light markdown styling. Tables line up their columns, or fall back to `Header: value` lines when the terminal is too narrow.

Everything else is just your terminal. Scrollback, selection and search all work, because nothing redraws the screen.

Full tool output isn't shown. It's in `~/.local/state/pith/sessions/`, one log per launch. Your keys are redacted there and nothing else is, so read a log before you share it.

## What it doesn't do

Resume a session, compact context, sandbox anything, read images, run tools in parallel, or take plugins.

Checkboxes aren't rendered. Pages that need JavaScript come back mostly empty. Windows isn't supported.

## Development

```bash
npm run build     # after changing code; `pith` picks it up
npm test          # offline; no keys needed
npm run format    # Biome
```

Tests script the model's replies, so they cost nothing. CI runs the format check and the tests on every push.

```text
src/
  cli.ts          arguments, setup and the prompt loop
  loop.ts         the agent loop
  model.ts        talking to the model
  config.ts       the config file and AGENTS.md
  session.ts      the log
  transcript.ts   progress events → what you see
  terminal.ts     all terminal output
  render.ts       tool rows and the turn summary
  markdown.ts     markdown styling and tables
  ansi.ts         escape codes, by name
  tools/          one folder per tool, plus shared helpers
prompt.md         the whole system prompt
```
