import { randomUUID } from 'node:crypto';
import { mkdir, open, readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Message, ToolCall } from '@earendil-works/pi-ai';
import { redact } from './config.js';

const SESSIONS_DIRECTORY = join(homedir(), '.local', 'state', 'pith', 'sessions');
const LOG_VERSION = 1;
const OWNER_ONLY_DIRECTORY = 0o700;
const OWNER_ONLY_FILE = 0o600;

export type RecordEvent = (event: Record<string, unknown>) => Promise<void>;

export interface SessionLog {
  id: string;
  path: string;
  record: RecordEvent;
  close(): Promise<void>;
}

// Append-only JSONL audit log, one file per launch. Written for inspection, never replayed.
export async function openSessionLog(
  metadata: Record<string, unknown>,
  secrets: (string | undefined)[],
  directory = SESSIONS_DIRECTORY,
): Promise<SessionLog> {
  await mkdir(directory, { recursive: true, mode: OWNER_ONLY_DIRECTORY });
  const id = randomUUID();
  const startedAt = new Date().toISOString().replaceAll(':', '-');
  const path = join(directory, `${startedAt}-${id}.jsonl`);
  const handle = await open(path, 'ax', OWNER_ONLY_FILE);

  const record: RecordEvent = async event => {
    const line = JSON.stringify({ timestamp: Date.now(), ...event });
    await handle.writeFile(`${redact(line, secrets)}\n`);
    // Synced, so a tool never runs ahead of its start marker.
    await handle.sync();
  };
  try {
    await record({ type: 'session', version: LOG_VERSION, id, ...metadata });
  } catch (error) {
    await handle.close();
    throw error;
  }
  return { id, path, record, close: () => handle.close() };
}

export interface PastSession {
  path: string;
  label: string; // the first thing the user asked
  text: string; // everything the user asked, for searching
  prompts: number;
  updatedAt: number;
}

// Earlier sessions in this workspace, newest first. A conversation starts after its last reset.
export async function listSessions(
  cwd: string,
  directory = SESSIONS_DIRECTORY,
): Promise<PastSession[]> {
  const sessions: PastSession[] = [];
  for (const name of await readdir(directory).catch(() => [])) {
    const path = join(directory, name);
    const messages = await readConversation(path, cwd);
    const prompts = messages.filter(message => message.role === 'user');
    if (!prompts.length) continue;
    const label = String(prompts[0]!.content).replace(/\s+/g, ' ').trim();
    const text = prompts.map(prompt => String(prompt.content)).join('\n');
    const updatedAt = (await stat(path)).mtimeMs;
    sessions.push({ path, label, text, prompts: prompts.length, updatedAt });
  }
  return sessions.sort((a, b) => b.updatedAt - a.updatedAt);
}

// The conversation a log holds, or nothing if it belongs to another workspace. A log that ended
// mid-turn gets "not run" results, so every tool call has an answer, as the loop requires.
export async function readConversation(path: string, cwd: string): Promise<Message[]> {
  const events = (await readFile(path, 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
  if (events[0]?.cwd !== cwd) return [];
  const reset = events.findLastIndex(event => event.type === 'context_reset');
  const messages: Message[] = events
    .slice(reset + 1)
    .filter(e => e.type === 'message')
    .map(e => e.message);

  const lastCall = messages.findLastIndex(message => message.role === 'assistant');
  const calls = (messages[lastCall]?.content ?? []) as { type: string }[];
  const answered = new Set(
    messages.slice(lastCall + 1).map(message => 'toolCallId' in message && message.toolCallId),
  );
  for (const call of calls.filter((block): block is ToolCall => block.type === 'toolCall')) {
    if (answered.has(call.id)) continue;
    messages.push({
      role: 'toolResult',
      toolCallId: call.id,
      toolName: call.name,
      content: [{ type: 'text', text: 'Not run: the session ended before this tool ran.' }],
      isError: true,
      timestamp: Date.now(),
    });
  }
  return messages;
}
