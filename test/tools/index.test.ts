import test from 'node:test';
import assert from 'node:assert/strict';
import { createTools } from '../../src/tools/index.js';
import { call, fixture, signal } from './helpers.js';

test('all six tools are always available', async t => {
  const tools = await createTools(await fixture(t));
  assert.deepEqual(
    tools.definitions.map(tool => tool.name),
    ['read', 'write', 'edit', 'bash', 'search', 'fetch'],
  );
});

test('unknown tools, missing arguments and unexpected properties return errors', async t => {
  const tools = await createTools(await fixture(t));
  for (const c of [
    call('missing', {}),
    call('read', {}),
    call('bash', { command: 'echo hi', surprise: 1 }),
    call('read', { path: 'a', offset: -1 }),
  ]) {
    assert.equal((await tools.execute(c, signal())).isError, true);
  }
});
