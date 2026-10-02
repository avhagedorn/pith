# pith

A small, plain-terminal coding agent for Alan.

**TypeScript + Node + pi-ai. One model. Four tools. Our own loop.**

No TUI framework, server, extensions, resource discovery, subagents, model switching or automatic compaction.

## Run

From the repository you want to work on:

```sh
cd /path/to/your/repo
~/dev/pith/pith --allow-local-tools
```

Or specify the workspace explicitly:

```sh
~/dev/pith/pith --cwd /path/to/repo --allow-local-tools
```

One task, then exit:

```sh
~/dev/pith/pith --cwd /path/to/repo --allow-local-tools \
  "inspect the failing tests, fix the bug, and verify the change"
```

Without `--allow-local-tools`, only the workspace-scoped `read` tool is available:

```sh
~/dev/pith/pith --cwd /path/to/repo "read package.json and explain the scripts"
printf 'read README.md and summarize it' | ~/dev/pith/pith --cwd /path/to/repo
```

### Authentication

Resolution order:

1. `OPENROUTER_API_KEY` in the current process environment.
2. The **OpenRouter API-key entry only** in `~/.pi/agent/auth.json`, read-only. A saved environment-variable reference also works if that variable is exported.

Your existing Pi key works. Nothing is copied into this project, and Pi's credential file is never modified. Auth commands and OAuth are intentionally unsupported. The app does not load `.env` files or Pi's other settings/resources.

Check local setup without a paid request:

```sh
~/dev/pith/pith --check
```

This checks the local key source and model catalog, **not** remote key validity or remaining balance.

### Terminal behavior

- Output appends normally. Native terminal scrollback, selection and search remain available.
- Node readline handles the prompt; there is no screen renderer or persistent editor.
- Keystrokes during a run are discarded (not echoed, not queued) except Ctrl-C. No steering/input queue.
- `/new` clears model context; old events remain in the audit log.
- `/exit` or Ctrl-D at the prompt exits. Ctrl-C at the prompt exits too.
- Ctrl-C during a run cancels the request/tool and returns to the prompt.
- Model text goes to stdout. Tool activity, the turn summary and stop reasons go to stderr.
- Each tool call is one dimmed row: `◆ $ npm test {12 lines · 3s}`, `◆ edit src/a.ts {+3/-1}`. Green diamond on success, red on failure (failures show the last output line). Full tool output is in the session log, not on screen.
- Consecutive successes of the same tool share a row: `◆ 4× read src/a.ts {120 lines}`.
- Each turn ends with a dim rule carrying the summary: `── Read 6 files, edited 2 files, ran 3 commands, 1 failed · 42s · ~$0.0009 ───`.
- The `❯` prompt and what you type are bold cyan; agent text is the default color with no prefix.
- Still no screen renderer. On a terminal the current line is redrawn (running → done) and a burst rewrites the row directly above; nothing else moves the cursor. When stderr is not a terminal, rows are plain appended lines with no escapes, no bursts, and `✗` for failures. `NO_COLOR` disables colors.
- Model text prints one completed line at a time (not token by token) with light markdown styling: headings, bold, italic, strikethrough, `` `code` ``, fenced blocks, links, blockquotes, rules, bullets and table pipes. Table columns are not aligned; checkboxes, images and HTML pass through raw. Blank-line runs collapse to one. With `NO_COLOR` or piped stdout the markdown is printed unchanged.
- Terminal control characters are stripped from generated output.
- Piped input and command-line prompts are capped at 64 KiB. Long/multiline tasks can be passed as a file through stdin; no custom multiline editor yet.

## Fixed model configuration

- Provider: **OpenRouter**.
- Model: **`z-ai/glm-5.3-flash`**.
- Reasoning: **low**.
- Per-response output cap: **8,192 tokens**.
- Per-request time limit: **120 seconds**.
- SDK request retries: **0**.
- No fallback model list; OpenRouter may route between hosts serving this same model.
- OpenRouter context transforms are disabled explicitly.
- Usage costs are **pi-ai catalog estimates**, not authoritative billing. Partial/cancelled requests may have incomplete usage reporting.

`@earendil-works/pi-ai` is pinned to **1.0.0**, with the dependency tree locked in `package-lock.json`. Only its OpenRouter provider is registered. It is our one direct runtime dependency, but it has transitive dependencies and ships other provider adapters. This is a behaviorally small harness, not a dependency-free one.

We use pi-ai's TypeBox schemas and built-in validation instead of adding Zod. We do **not** use `pi-agent-core`, `AgentSession`, pi-tui, or the full coding-agent runtime.

## Tools and execution boundaries

| Tool | Behavior |
|---|---|
| `read` | UTF-8 text, numbered lines, optional offset/limit. Default 200 lines; maximum 2,000. |
| `write` | Create/replace a file through a temporary file and rename. |
| `edit` | One exact search/replace. Missing and ambiguous matches fail without editing. |
| `bash` | `/bin/bash --noprofile --norc -c …`, cwd fixed for each invocation, stdin closed. |

- File tools check canonical workspace paths; ordinary traversal and out-of-workspace symlinks are rejected.
- Text reads/writes are capped at **2 MiB**. Binary/image files are not supported in v0.
- Tool results are capped at **32 KiB** with a truncation notice.
- Shell stdout/stderr are combined and bounded while both streams keep draining.
- Shell timeout defaults to **30 seconds**, with a model-selectable maximum of **120 seconds**.
- Tool calls execute sequentially. Unknown tools and invalid arguments become error results.
- Shell children inherit a small environment allowlist, not the harness's API keys or `BASH_ENV`.
- Timeout/Ctrl-C kills the shell process group. Deliberately detached descendants can escape that group; this is not an OS-level containment guarantee.
- No persistent background jobs. Shell startup profiles are skipped, so aliases/functions/version-manager initialization are not available; exported `PATH` is retained.

**`--allow-local-tools` enables unsandboxed shell execution with your OS permissions.**

Workspace checks and environment filtering reduce accidental exposure; they are not a sandbox. The shell can still access your home directory, credential files and network. Concurrent filesystem changes can also race file-path checks. Use a disposable checkout or a properly restricted container/OS account for untrusted tasks. Keep provider credentials outside the tool execution environment if stronger isolation is required. The prompt's instructions are not a security boundary.

Review `git diff`. Nothing automatically commits or pushes.

## Context and logs

Each launch creates a private JSONL log under:

```text
~/.local/state/pith/sessions/
```

New session directories use mode `0700`; log files use `0600`.

The header records the fixed model, prompt, tool definitions and workspace. Subsequent lines record full pi-ai messages (including reasoning/signature metadata), tool-start markers, incomplete responses and visible stop reasons. The known API key is redacted from serialized log lines. **Logs can still contain other sensitive workspace/prompt data; inspect before sharing.**

Only complete accepted model responses enter the in-memory conversation. Partially streamed tool arguments never execute. Each complete tool call gets a corresponding result; cancellation settles the remaining calls as not executed. Errors and denied/unknown tools are reported back to the model.

A tool-start marker is flushed before execution. If a process crashes without recording its result, the outcome is **unknown**—do not assume the action can be safely replayed.

**No disk resume in v0.** Logs are for inspection, not automatic replay. This keeps recovery semantics small and avoids silently rerunning uncertain shell actions.

Limits per user turn:

- **20 model requests**, then a visible stop. You can ask to continue.
- **512 KiB serialized input context**, then a visible stop. This is a conservative byte cap, not an exact tokenizer. Use `/new` to start fresh.
- No hidden summaries, pruning, retries, project instruction loading or memory retrieval.

## Source layout

```text
src/
  cli.ts       input/output and cancellation
  render.ts    one-line tool rows and the turn summary
  auth.ts      environment / read-only Pi credential lookup
  model.ts     fixed OpenRouter model and streaming adapter
  loop.ts      the orchestration loop
  tools.ts     schemas, file tools and dispatch
  shell.ts     bounded subprocess execution and cancellation
  session.ts   private append-only audit log
prompt.md      the entire base system prompt
```

## Development

Requires **Node 22.19+**, npm, and macOS/Linux. `bash`, `git` and `rg` are useful workspace utilities; Windows process handling is not implemented.

```sh
cd ~/dev/pith
npm ci --ignore-scripts
npm run build
npm test
npm run format   # Biome, formatter only; format:check for a dry run
```

`pith` runs the compiled code while preserving your current working directory. Rebuild after changing TypeScript. No global installation or shell-profile modification is needed.

The default test suite is offline and uses scripted model responses. It covers tool pairing, sequential execution, reasoning preservation, cancellation, malformed/partial responses, limits, disk failure, schemas, file edits, symlink/traversal rejection, FIFO rejection, subprocess output/timeouts, credential resolution and private log serialization.

A live smoke test with the real model/key also passed: it read a deliberately broken addition function and its test, made an exact edit, ran the test, and reported success. The result was independently verified afterward. Live calls use OpenRouter credit; `npm test` does not.

## Deliberately not built yet

Disk resume, OS sandbox integration, images, multiline editor, automatic context compaction, diffs in the renderer, cost budgets, parallel tools, project-context discovery, provider switching and any plugin system.

The next useful step is to try this on a small real task before adding another feature.
