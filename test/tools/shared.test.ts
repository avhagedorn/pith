import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createTools } from '../../src/tools/index.js';
import { workspacePath } from '../../src/tools/shared.js';
import { call, fixture, signal } from './helpers.js';

test('workspace paths reject traversal and symlinks to outside files/directories', async t => {
  const root = await fixture(t);
  const outside = await fixture(t);
  await writeFile(join(outside, 'secret.txt'), 'not allowed');
  await symlink(outside, join(root, 'escape'));
  const tools = await createTools(root, true);
  for (const path of ['../secret.txt', join(outside, 'secret.txt'), 'escape/secret.txt']) {
    assert.equal((await tools.execute(call('read', { path }), signal())).isError, true);
  }
  assert.equal((await tools.execute(call('write', { path: 'escape/new.txt', content: 'no' }), signal())).isError, true);
  assert.equal(
    (await tools.execute(call('edit', { path: 'escape/secret.txt', oldText: 'not', newText: 'now' }), signal()))
      .isError,
    true,
  );
  assert.deepEqual(await readdir(outside), ['secret.txt']);
  // root returned by createTools is canonicalized (/var vs /private/var on macOS).
  const canonical = await realpath(root);
  assert.equal(await workspacePath(canonical, 'new/a.txt'), join(canonical, 'new/a.txt'));
});
