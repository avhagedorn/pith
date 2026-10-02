import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createTools } from '../../src/tools/index.js';
import { call, fixture, signal } from './helpers.js';

test('edit makes one exact replacement and keeps the file mode', async t => {
  const root = await fixture(t);
  const tools = await createTools(root, true);
  await writeFile(join(root, 'example.txt'), 'one\ntwo\nthree');
  await chmod(join(root, 'example.txt'), 0o640);
  const result = await tools.execute(call('edit', { path: 'example.txt', oldText: 'two', newText: 'TWO' }), signal());
  assert.equal(result.isError, false);
  assert.equal(await readFile(join(root, 'example.txt'), 'utf8'), 'one\nTWO\nthree');
  assert.deepEqual(await readdir(root), ['example.txt']);
  assert.equal((await stat(join(root, 'example.txt'))).mode & 0o777, 0o640);
});

test('ambiguous (including overlapping) or missing edits do not change files', async t => {
  const root = await fixture(t);
  const tools = await createTools(root, true);
  await writeFile(join(root, 'a.txt'), 'aaa');
  for (const oldText of ['aa', 'missing']) {
    const result = await tools.execute(call('edit', { path: 'a.txt', oldText, newText: 'oops' }), signal());
    assert.equal(result.isError, true);
    assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'aaa');
  }
});
