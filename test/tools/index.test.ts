import test from 'node:test';
import assert from 'node:assert/strict';
import { createTools } from '../../src/tools/index.js';
import { call, fixture, signal } from './helpers.js';

test('four tools only when local execution is explicitly enabled', async t => {
  const root = await fixture(t);
  const readonly = await createTools(root, false);
  assert.deepEqual(
    readonly.definitions.map(t => t.name),
    ['read'],
  );
  assert.equal(
    (await readonly.execute(call('bash', { command: 'echo denied' }), signal())).isError,
    true,
  );
  assert.deepEqual(
    (await createTools(root, true)).definitions.map(t => t.name),
    ['read', 'write', 'edit', 'bash'],
  );
});

test('unknown tools, missing arguments and unexpected properties return errors', async t => {
  const tools = await createTools(await fixture(t), true);
  for (const c of [
    call('missing', {}),
    call('read', {}),
    call('bash', { command: 'echo hi', surprise: 1 }),
    call('read', { path: 'a', offset: -1 }),
  ]) {
    assert.equal((await tools.execute(c, signal())).isError, true);
  }
});
