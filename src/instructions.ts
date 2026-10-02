import { join } from 'node:path';
import { errorCode, errorText } from './errors.js';
import { bounded, readText } from './tools/shared.js';

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
