import { constants } from 'node:fs';
import { mkdir, open, realpath, rename, rm, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Type, validateToolCall, type Static, type TSchema, type Tool, type ToolCall } from '@earendil-works/pi-ai';
import { MAX_OUTPUT_BYTES, runShell } from './shell.js';

const MAX_FILE_BYTES = 2 * 1024 * 1024;
export interface ToolOutput { text: string; isError: boolean }
export interface ToolSet {
  definitions: Tool[];
  execute(call: ToolCall, signal: AbortSignal): Promise<ToolOutput>;
}

export function bounded(text: string): string {
  const bytes = Buffer.from(text);
  return bytes.length <= MAX_OUTPUT_BYTES ? text
    : bytes.subarray(0, MAX_OUTPUT_BYTES).toString('utf8') + '\n[output truncated at 32 KiB]';
}

// Canonical path check catches accidental traversal/symlinks. Not a sandbox:
// concurrent filesystem changes and the explicitly enabled shell remain outside it.
export async function workspacePath(root: string, input: string): Promise<string> {
  const candidate = resolve(root, input);
  const contained = (path: string) => {
    const rel = relative(root, path);
    if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw new Error('Path is outside the workspace.');
  };
  contained(candidate);
  let ancestor = candidate;
  while (true) {
    try {
      const canonical = await realpath(ancestor);
      contained(canonical);
      return resolve(canonical, relative(ancestor, candidate));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }
}

async function readText(path: string): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    if (!(await handle.stat()).isFile()) throw new Error('Expected a regular text file, not a directory/device.');
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const { bytesRead } = await handle.read(buffer, bytes, buffer.length - bytes, bytes);
      if (!bytesRead) break;
      bytes += bytesRead;
    }
    if (bytes > MAX_FILE_BYTES) throw new Error('File exceeds 2 MiB; use a bounded shell command instead.');
    const content = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytes));
    if (content.includes('\0')) throw new Error('Binary files are not supported.');
    return content;
  } finally { await handle.close(); }
}

async function atomicWrite(path: string, content: string, signal: AbortSignal): Promise<void> {
  if (Buffer.byteLength(content) > MAX_FILE_BYTES) throw new Error('Write exceeds 2 MiB.');
  signal.throwIfAborted();
  await mkdir(dirname(path), { recursive: true });
  const existing = await stat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    return undefined;
  });
  if (existing && !existing.isFile()) throw new Error('Expected a regular file.');
  const temp = `${path}.pith-${randomUUID()}.tmp`;
  try {
    const handle = await open(temp, 'wx', existing ? existing.mode & 0o777 : 0o600);
    try { await handle.writeFile(content); await handle.sync(); }
    finally { await handle.close(); }
    signal.throwIfAborted();
    await rename(temp, path);
  } finally { await rm(temp, { force: true }); }
}

export async function createTools(cwd: string, allowLocalTools: boolean): Promise<ToolSet> {
  const root = await realpath(cwd);
  const definitions: Tool[] = [];
  const runners = new Map<string, (call: ToolCall, signal: AbortSignal) => Promise<ToolOutput>>();
  function register<S extends TSchema>(
    name: string, description: string, parameters: S,
    run: (args: Static<S>, signal: AbortSignal) => Promise<ToolOutput>,
  ) {
    const definition: Tool = { name, description, parameters };
    definitions.push(definition);
    runners.set(name, (call, signal) => run(validateToolCall([definition], call) as Static<S>, signal));
  }
  const path = Type.String({ minLength: 1, maxLength: 4096 });
  const options = { additionalProperties: false };
  register('read', 'Read a UTF-8 text file inside the workspace (max 2 MiB). Returns numbered lines, capped at 32 KiB. Offsets are 1-based.',
    Type.Object({ path, offset: Type.Optional(Type.Integer({ minimum: 1 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000 })) }, options),
    async ({ path, offset = 1, limit = 200 }, signal) => {
      signal.throwIfAborted();
      const text = await readText(await workspacePath(root, path));
      const lines = text.split('\n');
      const end = Math.min(lines.length, offset - 1 + limit);
      const selected = lines.slice(offset - 1, end).map((line, i) => `${offset + i}: ${line}`).join('\n');
      return { text: bounded(selected + (end < lines.length ? `\n[more lines: next offset ${end + 1}]` : '')), isError: false };
    });

  if (allowLocalTools) {
    register('write', 'Create or replace a UTF-8 file inside the workspace. Prefer edit for existing files. Writes are capped at 2 MiB.',
      Type.Object({ path, content: Type.String({ maxLength: MAX_FILE_BYTES }) }, options),
      async ({ path, content }, signal) => {
        await atomicWrite(await workspacePath(root, path), content, signal);
        return { text: `Wrote ${Buffer.byteLength(content)} bytes to ${path}.`, isError: false };
      });
    register('edit', 'Replace exactly one occurrence of oldText with newText in a UTF-8 file. Fails on missing or ambiguous matches. Read first.',
      Type.Object({ path, oldText: Type.String({ minLength: 1, maxLength: MAX_FILE_BYTES }), newText: Type.String({ maxLength: MAX_FILE_BYTES }) }, options),
      async ({ path, oldText, newText }, signal) => {
        const target = await workspacePath(root, path);
        const original = await readText(target);
        const start = original.indexOf(oldText);
        if (start < 0) throw new Error('oldText not found. Read the file again before editing.');
        if (original.indexOf(oldText, start + 1) >= 0) throw new Error('oldText is ambiguous. Include more surrounding text.');
        const updated = original.slice(0, start) + newText + original.slice(start + oldText.length);
        await atomicWrite(target, updated, signal);
        return { text: `Edited ${path}: one exact replacement.`, isError: false };
      });
    register('bash', 'Run a non-interactive bash command in the workspace. UNSANDBOXED. No background jobs. stdout/stderr combined, capped at 32 KiB. Default timeout 30s; maximum 120s.',
      Type.Object({ command: Type.String({ minLength: 1, maxLength: 32_768 }), timeout: Type.Optional(Type.Integer({ minimum: 1, maximum: 120 })) }, options),
      ({ command, timeout = 30 }, signal) => runShell(command, root, signal, timeout * 1000));
  }
  return {
    definitions,
    async execute(call, signal) {
      try {
        signal.throwIfAborted();
        const run = runners.get(call.name);
        if (!run) throw new Error(`Unknown or disabled tool: ${call.name}`);
        const result = await run(call, signal);
        return { ...result, text: bounded(result.text) };
      } catch (error) {
        return { text: bounded(error instanceof Error ? error.message : String(error)), isError: true };
      }
    },
  };
}
