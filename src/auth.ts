import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export async function resolveKey(
  env: NodeJS.ProcessEnv = process.env,
  authPath = join(homedir(), '.pi', 'agent', 'auth.json'),
): Promise<{ key: string; source: string }> {
  const direct = env.OPENROUTER_API_KEY?.trim();
  if (direct) return { key: direct, source: 'OPENROUTER_API_KEY' };

  let data: unknown;
  try {
    data = JSON.parse(await readFile(authPath, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error('Cannot read Pi credentials. Set OPENROUTER_API_KEY instead.');
    }
  }
  if (data && typeof data === 'object' && 'openrouter' in data) {
    const credential = data.openrouter;
    if (credential && typeof credential === 'object' && 'type' in credential &&
        credential.type === 'api_key' && 'key' in credential && typeof credential.key === 'string') {
      const configured = credential.key.trim();
      // Only this provider's key. No credential commands, OAuth, writes or copies.
      if (configured.startsWith('!')) {
        throw new Error('Pi uses a credential command. Export OPENROUTER_API_KEY; pith does not execute auth commands.');
      }
      const key = env[configured]?.trim() || (configured.startsWith('sk-or-') ? configured : undefined);
      if (key) return { key, source: 'Pi openrouter credential (read-only)' };
    }
  }
  throw new Error('No OpenRouter API key. Set OPENROUTER_API_KEY or store an API key for openrouter in Pi.');
}
