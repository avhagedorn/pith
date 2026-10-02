import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { errorCode, errorText } from './errors.js';
import { bounded, readText } from './tools/shared.js';

export const CONFIG_PATH = join(homedir(), '.config', 'pith', 'config.json');
const OTHERS_CAN_READ = 0o077;
const REDACTED = '[REDACTED]';

export interface Config {
  openrouterApiKey: string;
  exaApiKey?: string; // optional: lifts the rate limit on anonymous search
}

export const redact = (text: string, secrets: (string | undefined)[]) =>
  secrets.reduce<string>((out, secret) => (secret ? out.replaceAll(secret, REDACTED) : out), text);

// The one place keys come from. Because it holds them, a file other users can read is refused.
export async function loadConfig(path = CONFIG_PATH): Promise<Config> {
  let file: Record<string, unknown>;
  try {
    if ((await stat(path)).mode & OTHERS_CAN_READ) {
      throw new Error(`${path} holds API keys but is readable by others. Run: chmod 600 ${path}`);
    }
    file = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (errorCode(error) === 'ENOENT') throw new Error(`No config. Create ${path} (see README).`);
    if (error instanceof SyntaxError) throw new Error(`${path} is not valid JSON.`);
    throw error;
  }

  const key = (name: keyof Config) => {
    const value = file?.[name];
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  };
  const openrouterApiKey = key('openrouterApiKey');
  if (!openrouterApiKey) throw new Error(`Add "openrouterApiKey" to ${path}.`);
  return { openrouterApiKey, exaApiKey: key('exaApiKey') };
}

export const INSTRUCTIONS_FILE = 'AGENTS.md';

// The workspace's own instructions for agents, if it has any. Capped like a tool result.
export async function projectInstructions(cwd: string): Promise<string | undefined> {
  try {
    return bounded((await readText(join(cwd, INSTRUCTIONS_FILE))).trim()) || undefined;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw new Error(`Cannot read ${INSTRUCTIONS_FILE}: ${errorText(error)}`);
  }
}
