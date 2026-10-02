import { randomUUID } from 'node:crypto';
import { mkdir, open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
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
