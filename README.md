# pith

A small coding agent for your terminal.

It asks a model what to do, runs the tools the model asks for, and keeps going until it has an answer. That's the whole thing: about **1,600 lines** of TypeScript, six tools, no TUI, no context bloat.

![pith finding and fixing a failing test, then searching the web](docs/demo.gif)

## Try it

macOS or Linux, Node 22.19+.

```bash
git clone https://github.com/avhagedorn/pith.git
cd pith
npm install
npm link
```

That builds it and puts `pith` on your PATH.

Then create `~/.config/pith/config.json`:

```jsonc
{
  "openrouterApiKey": "sk-or-...",
  "model": "an OpenRouter model id",

  // everything below this line is optional
  "exaApiKey": "...",
  "reasoning": "low"
}
```

```bash
chmod 600 ~/.config/pith/config.json
```

The model can be anything on [OpenRouter](https://openrouter.ai) that supports tool calls. An [Exa](https://exa.ai) key lifts the rate limit on web search. `reasoning` is shown at its default.

Now go to a repo and run it:

```bash
pith
```

To pick up an earlier conversation in that repo, type `/resume` at the prompt, or `/resume <words>` to list only the sessions that mention them.

## What it does

- Reads, writes and edits files in the repo you run it in.
- Runs shell commands.
- Searches the web and reads pages.
- Keeps going on its own: it asks the model, runs the tools the model asks for, and repeats until the model answers in plain text.
- Shows each tool call as one line, and ends each turn with what it did, how long it took and roughly what it cost.
- Logs everything to `~/.local/state/pith/sessions/`.

## What it doesn't do

- Compact a long session.
- Sandbox anything.
- Run tools in parallel.
- Read images.
- Take plugins.
- Run on Windows.

## Trade-offs

**No sandbox.** `bash` runs with your permissions. That keeps pith small and means you should only point it at things you trust.

**No screen redraws.** Scrollback, selection and search work like in any other terminal. In exchange, answers arrive a line at a time and you can't type while it's working.

**Tool output is hidden.** You see one line per call, so the screen stays readable. The full output is in the log.

**One model, no retries.** What you configure is what runs. If a request fails, it fails.

**Nothing is summarised.** The model always sees the real conversation. A long session eventually hits the cap, and then you start a new one.

**Web content is marked, not blocked.** Everything from `search` and `fetch` is labelled as untrusted before the model sees it. That makes a malicious page less likely to work. It doesn't make it impossible.

## How it works

### The loop

Ask the model. Run the tools it asks for. Repeat until it answers in text. That's most of [`loop.ts`](src/loop.ts).

A turn has no step limit. It ends when the model answers, when you cancel, or at **512 KiB** of context.

### Six tools

| Tool | What it does |
|---|---|
| `read` | Numbered lines from a text file. |
| `write` | Creates or replaces a file. |
| `edit` | One exact search and replace. If the match is missing or ambiguous, nothing changes. |
| `bash` | Runs a command in the repo. |
| `search` | Web search: titles, URLs and excerpts. |
| `fetch` | A web page as plain text. |

File tools stay inside the repo. Tool results are capped at **32 KiB**. When a command prints more than that, the middle is dropped and both ends are kept, because the error is usually at the bottom.

### What you see

Tool calls are one line each. Answers print a line at a time with light markdown styling.

Nothing redraws the screen. The only cursor movement is updating the line a running tool is on.

## Why?

I believe these things:
1. Models are smart and can figure it out
2. Context bloat is a disease that burns tokens. Per 1, models are smart enough
3. GUI / TUI interfaces are often clunky / slow
4. Understanding how a harness I use everyday operates is a win

For months my main and only harness has been [Pi](https://pi.dev/). After the [Pi 1.0 update](https://earendil.com/posts/pi-1-0/) however, I felt they moved away from the low-bloat extreme that had enticed me to switch from Claude Code.

I run local llms quite often and Pi was the only harness that didn't saturate my context window with useless jargon.

I figure now is as good a time as any to try to build a super small harness :)
