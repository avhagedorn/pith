import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { errorCode, errorText } from './errors.js';
import { bounded, readText } from './tools/shared.js';

export const CONFIG_PATH = join(homedir(), '.config', 'pith', 'config.json');
const OTHERS_CAN_READ = 0o077;
const REDACTED = '[REDACTED]';
const COMMENT_LINES = /^\s*\/\/.*$/gm;

const REASONING_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
const DEFAULTS = { reasoning: 'low', maxOutputTokens: 8192, maxSteps: 20 } as const;

export interface Config {
  openrouterApiKey: string;
  model: string; // an OpenRouter model id
  exaApiKey?: string; // optional: lifts the rate limit on anonymous search
  reasoning: (typeof REASONING_LEVELS)[number];
  maxOutputTokens: number; // per model response
  maxSteps: number; // model requests allowed in one turn
}

export const redact = (text: string, secrets: (string | undefined)[]) =>
  secrets.reduce<string>((out, secret) => (secret ? out.replaceAll(secret, REDACTED) : out), text);

// The one place settings come from. It holds keys, so a file other users can read is refused.
export async function loadConfig(path = CONFIG_PATH): Promise<Config> {
  let file: Record<string, unknown>;
  try {
    if ((await stat(path)).mode & OTHERS_CAN_READ) {
      throw new Error(`${path} holds API keys but is readable by others. Run: chmod 600 ${path}`);
    }
    // Whole-line // comments are allowed, so the file can be annotated.
    file = JSON.parse((await readFile(path, 'utf8')).replace(COMMENT_LINES, ''));
  } catch (error) {
    if (errorCode(error) === 'ENOENT') throw new Error(`No config. Create ${path} (see README).`);
    if (error instanceof SyntaxError) throw new Error(`${path} is not valid JSON.`);
    throw error;
  }

  const text = (name: keyof Config) => {
    const value = file?.[name];
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  };
  const count = (name: 'maxOutputTokens' | 'maxSteps') => {
    const value = file?.[name] ?? DEFAULTS[name];
    if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
    throw new Error(`"${name}" in ${path} must be a positive whole number.`);
  };

  const [openrouterApiKey, model] = [text('openrouterApiKey'), text('model')];
  if (!openrouterApiKey) throw new Error(`Add "openrouterApiKey" to ${path}.`);
  if (!model) throw new Error(`Add "model" to ${path}.`);
  const reasoning = REASONING_LEVELS.find(
    level => level === (file.reasoning ?? DEFAULTS.reasoning),
  );
  if (!reasoning) {
    throw new Error(`"reasoning" in ${path} must be one of: ${REASONING_LEVELS.join(', ')}.`);
  }
  return {
    openrouterApiKey,
    model,
    exaApiKey: text('exaApiKey'),
    reasoning,
    maxOutputTokens: count('maxOutputTokens'),
    maxSteps: count('maxSteps'),
  };
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
