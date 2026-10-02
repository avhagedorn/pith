import type test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolCall } from '@earendil-works/pi-ai';

export const signal = () => new AbortController().signal;
export const call = (name: string, args: ToolCall['arguments']): ToolCall => ({
  type: 'toolCall',
  id: 'test',
  name,
  arguments: args,
});
// A throwaway workspace, removed when the test ends.
export async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'pith-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
