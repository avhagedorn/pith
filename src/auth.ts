import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { errorCode } from './errors.js';

const KEY_VARIABLE = 'OPENROUTER_API_KEY';
const KEY_PREFIX = 'sk-or-';
const COMMAND_PREFIX = '!';
const PI_AUTH_PATH = join(homedir(), '.pi', 'agent', 'auth.json');
const REDACTED = '[REDACTED]';

export const redact = (text: string, key: string) => (key ? text.replaceAll(key, REDACTED) : text);

// Environment first, then Pi's saved credential. Pi's file is only ever read.
export async function resolveKey(
  env: NodeJS.ProcessEnv = process.env,
  authPath = PI_AUTH_PATH,
): Promise<{ key: string; source: string }> {
  const fromEnv = env[KEY_VARIABLE]?.trim();
  if (fromEnv) return { key: fromEnv, source: KEY_VARIABLE };

  const saved = await savedCredential(authPath);
  if (saved?.startsWith(COMMAND_PREFIX)) {
    throw new Error(
      `Pi uses a credential command. Export ${KEY_VARIABLE}; pith does not execute auth commands.`,
    );
  }
  // Pi saves either the key or the name of a variable holding it.
  const key = saved && (env[saved]?.trim() || (saved.startsWith(KEY_PREFIX) ? saved : undefined));
  if (key) return { key, source: 'Pi openrouter credential (read-only)' };

  throw new Error(
    `No OpenRouter API key. Set ${KEY_VARIABLE} or store an API key for openrouter in Pi.`,
  );
}

// Only the openrouter API-key entry counts. OAuth and other providers are ignored.
async function savedCredential(path: string): Promise<string | undefined> {
  let file: { openrouter?: { type?: unknown; key?: unknown } } | null;
  try {
    file = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw new Error(`Cannot read Pi credentials. Set ${KEY_VARIABLE} instead.`);
  }
  const entry = file?.openrouter;
  return entry?.type === 'api_key' && typeof entry.key === 'string' ? entry.key.trim() : undefined;
}
