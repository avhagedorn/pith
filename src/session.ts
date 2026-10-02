import { randomUUID } from 'node:crypto';
import { mkdir, open, type FileHandle } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { redact } from './auth.js';

const SESSIONS_DIRECTORY = join(homedir(), '.local', 'state', 'pith', 'sessions');
const LOG_VERSION = 1;
const OWNER_ONLY_DIRECTORY = 0o700;
const OWNER_ONLY_FILE = 0o600;

export type RecordEvent = (event: Record<string, unknown>) => Promise<void>;

// Append-only JSONL audit log, one file per launch. Written for inspection, never replayed.
export class SessionLog {
  private constructor(
    public readonly id: string,
    public readonly path: string,
    private readonly handle: FileHandle,
    private readonly secret: string,
  ) {}

  static async create(
    metadata: Record<string, unknown>,
    secret: string,
    directory = SESSIONS_DIRECTORY,
  ): Promise<SessionLog> {
    await mkdir(directory, { recursive: true, mode: OWNER_ONLY_DIRECTORY });
    const id = randomUUID();
    const startedAt = new Date().toISOString().replaceAll(':', '-');
    const path = join(directory, `${startedAt}-${id}.jsonl`);
    const handle = await open(path, 'ax', OWNER_ONLY_FILE);
    const log = new SessionLog(id, path, handle, secret);
    try {
      await log.record({ type: 'session', version: LOG_VERSION, id, ...metadata });
    } catch (error) {
      await handle.close();
      throw error;
    }
    return log;
  }

  record: RecordEvent = async event => {
    const line = JSON.stringify({ timestamp: Date.now(), ...event });
    await this.handle.writeFile(`${redact(line, this.secret)}\n`);
    // Synced, so a tool never runs ahead of its start marker.
    await this.handle.sync();
  };

  close(): Promise<void> {
    return this.handle.close();
  }
}
