import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createTools } from '../../src/tools/index.js';
import { call, fixture, signal } from './helpers.js';

test('write creates nested files privately and leaves no temporary file behind', async t => {
  const root = await fixture(t);
  const tools = await createTools(root, true);
  const result = await tools.execute(
    call('write', { path: 'nested/example.txt', content: 'one\ntwo' }),
    signal(),
  );
  assert.equal(result.isError, false);
  assert.equal(await readFile(join(root, 'nested/example.txt'), 'utf8'), 'one\ntwo');
  assert.deepEqual(await readdir(join(root, 'nested')), ['example.txt']);
  assert.equal((await stat(join(root, 'nested/example.txt'))).mode & 0o777, 0o600);
});

test('write replaces an existing file and keeps its mode', async t => {
  const root = await fixture(t);
  const tools = await createTools(root, true);
  await writeFile(join(root, 'run.sh'), 'old');
  await chmod(join(root, 'run.sh'), 0o755);
  assert.equal(
    (await tools.execute(call('write', { path: 'run.sh', content: 'new' }), signal())).isError,
    false,
  );
  assert.equal(await readFile(join(root, 'run.sh'), 'utf8'), 'new');
  assert.equal((await stat(join(root, 'run.sh'))).mode & 0o777, 0o755);
});

test('already-cancelled operations do not write files', async t => {
  const root = await fixture(t);
  const tools = await createTools(root, true);
  const controller = new AbortController();
  controller.abort();
  assert.equal(
    (await tools.execute(call('write', { path: 'no.txt', content: 'no' }), controller.signal))
      .isError,
    true,
  );
  assert.deepEqual(await readdir(root), []);
});
