import { constants } from 'node:fs';
import { mkdir, open, realpath, rename, rm, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Type, validateToolCall, type Static, type TSchema, type Tool, type ToolCall } from '@earendil-works/pi-ai';

export const MAX_OUTPUT_BYTES = 32 * 1024;
export const MAX_FILE_BYTES = 2 * 1024 * 1024;
export interface ToolOutput {
  text: string;
  isError: boolean;
}
export interface ToolSet {
  definitions: Tool[];
  execute(call: ToolCall, signal: AbortSignal): Promise<ToolOutput>;
}
export interface ToolDef {
  definition: Tool;
  run(call: ToolCall, signal: AbortSignal): Promise<ToolOutput>;
}

// Shared schema pieces: a workspace-relative path, and no undeclared arguments.
export const path = Type.String({ minLength: 1, maxLength: 4096 });
export const strict = { additionalProperties: false };

// Pairs a schema with its runner; arguments are validated against the schema before the runner sees them.
export function defineTool<S extends TSchema>(
  name: string,
  description: string,
  parameters: S,
  run: (args: Static<S>, signal: AbortSignal) => Promise<ToolOutput>,
): ToolDef {
  const definition: Tool = { name, description, parameters };
  return { definition, run: (call, signal) => run(validateToolCall([definition], call) as Static<S>, signal) };
}

export function bounded(text: string): string {
  const bytes = Buffer.from(text);
  return bytes.length <= MAX_OUTPUT_BYTES
    ? text
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

export async function readText(path: string): Promise<string> {
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
  } finally {
    await handle.close();
  }
}

export async function atomicWrite(path: string, content: string, signal: AbortSignal): Promise<void> {
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
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    signal.throwIfAborted();
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
}
