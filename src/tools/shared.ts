import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, realpath, rename, rm, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import {
  Type,
  validateToolCall,
  type Static,
  type TSchema,
  type Tool,
  type ToolCall,
} from '@earendil-works/pi-ai';
import { errorCode } from '../errors.js';

export const MAX_OUTPUT_BYTES = 32 * 1024;
export const MAX_FILE_BYTES = 2 * 1024 * 1024;
const TRUNCATION_NOTICE = '\n[output truncated at 32 KiB]';
const MAX_PATH_LENGTH = 4096;
const NEW_FILE_MODE = 0o600;
const PERMISSION_BITS = 0o777;
// Non-blocking and no symlink-following: a FIFO cannot hang a read, a swapped link cannot move it.
const READ_FLAGS = constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW;

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

// Schema pieces every tool shares: a workspace path, and no undeclared arguments.
export const path = Type.String({ minLength: 1, maxLength: MAX_PATH_LENGTH });
export const strict = { additionalProperties: false };

// Pairs a schema with its runner. Arguments are validated before the runner sees them.
export function defineTool<S extends TSchema>(
  name: string,
  description: string,
  parameters: S,
  run: (args: Static<S>, signal: AbortSignal) => Promise<ToolOutput>,
): ToolDef {
  const definition: Tool = { name, description, parameters };
  return {
    definition,
    run: (call, signal) => run(validateToolCall([definition], call) as Static<S>, signal),
  };
}

export function bounded(text: string): string {
  const bytes = Buffer.from(text);
  if (bytes.length <= MAX_OUTPUT_BYTES) return text;
  return bytes.subarray(0, MAX_OUTPUT_BYTES).toString('utf8') + TRUNCATION_NOTICE;
}

// Catches accidental traversal and symlinks out of the workspace. Not a sandbox:
// files can change after the check, and the shell is not bound by it at all.
export async function workspacePath(root: string, input: string): Promise<string> {
  const candidate = resolve(root, input);
  const assertInside = (path: string) => {
    const rel = relative(root, path);
    const escapes = rel === '..' || rel.startsWith('../') || isAbsolute(rel);
    if (escapes) throw new Error('Path is outside the workspace.');
  };
  assertInside(candidate);

  // The target may not exist yet, so resolve symlinks on its nearest existing ancestor.
  let ancestor = candidate;
  while (true) {
    try {
      const canonical = await realpath(ancestor);
      assertInside(canonical);
      return resolve(canonical, relative(ancestor, candidate));
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }
}

export async function readText(path: string): Promise<string> {
  const handle = await open(path, READ_FLAGS);
  try {
    if (!(await handle.stat()).isFile()) {
      throw new Error('Expected a regular text file, not a directory/device.');
    }
    // One byte over the cap is enough to tell "at the limit" from "over it".
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const { bytesRead } = await handle.read(buffer, bytes, buffer.length - bytes, bytes);
      if (!bytesRead) break;
      bytes += bytesRead;
    }
    if (bytes > MAX_FILE_BYTES) {
      throw new Error('File exceeds 2 MiB; use a bounded shell command instead.');
    }
    const content = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytes));
    if (content.includes('\0')) throw new Error('Binary files are not supported.');
    return content;
  } finally {
    await handle.close();
  }
}

// Writes to a temporary file and renames it, so a reader never sees a half-written file.
export async function atomicWrite(
  path: string,
  content: string,
  signal: AbortSignal,
): Promise<void> {
  if (Buffer.byteLength(content) > MAX_FILE_BYTES) throw new Error('Write exceeds 2 MiB.');
  signal.throwIfAborted();
  await mkdir(dirname(path), { recursive: true });

  const existing = await stat(path).catch(error => {
    if (errorCode(error) !== 'ENOENT') throw error;
    return undefined;
  });
  if (existing && !existing.isFile()) throw new Error('Expected a regular file.');
  const mode = existing ? existing.mode & PERMISSION_BITS : NEW_FILE_MODE;

  const temp = `${path}.pith-${randomUUID()}.tmp`;
  try {
    const handle = await open(temp, 'wx', mode);
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
