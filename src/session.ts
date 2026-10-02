import { mkdir, open, type FileHandle } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export type RecordEvent = (event: Record<string, unknown>) => Promise<void>;

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
    directory = join(homedir(), '.local', 'state', 'pith', 'sessions'),
  ): Promise<SessionLog> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const id = randomUUID();
    const path = join(directory, `${new Date().toISOString().replaceAll(':', '-')}-${id}.jsonl`);
    const handle = await open(path, 'ax', 0o600);
    const log = new SessionLog(id, path, handle, secret);
    try { await log.record({ type: 'session', version: 1, id, ...metadata }); }
    catch (error) { await handle.close(); throw error; }
    return log;
  }

  record: RecordEvent = async (event) => {
    const line = JSON.stringify({ timestamp: Date.now(), ...event });
    await this.handle.writeFile((this.secret ? line.replaceAll(this.secret, '[REDACTED]') : line) + '\n');
    // Persist before a tool can run. No automatic crash replay in v0.
    await this.handle.sync();
  };

  close(): Promise<void> { return this.handle.close(); }
}
