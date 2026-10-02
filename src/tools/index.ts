import { realpath } from 'node:fs/promises';
import { errorText } from '../errors.js';
import { bash } from './bash/index.js';
import { edit } from './edit/index.js';
import { read } from './read/index.js';
import { bounded, type ToolSet } from './shared.js';
import { write } from './write/index.js';

export type { ToolOutput, ToolSet } from './shared.js';

// read is always on. Anything that can change the machine needs --allow-local-tools.
export async function createTools(cwd: string, allowLocalTools: boolean): Promise<ToolSet> {
  const root = await realpath(cwd);
  const tools = [read(root), ...(allowLocalTools ? [write(root), edit(root), bash(root)] : [])];
  const runners = new Map(tools.map(tool => [tool.definition.name, tool.run]));

  return {
    definitions: tools.map(tool => tool.definition),
    // Never throws: bad arguments and tool failures come back as error results for the model.
    async execute(call, signal) {
      try {
        signal.throwIfAborted();
        const run = runners.get(call.name);
        if (!run) throw new Error(`Unknown or disabled tool: ${call.name}`);
        const result = await run(call, signal);
        return { ...result, text: bounded(result.text) };
      } catch (error) {
        return { text: bounded(errorText(error)), isError: true };
      }
    },
  };
}
