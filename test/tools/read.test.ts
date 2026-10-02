import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createTools } from '../../src/tools/index.js';
import { MAX_OUTPUT_BYTES } from '../../src/tools/shared.js';
import { call, fixture, signal } from './helpers.js';

test('read numbers lines, honours offset/limit and points at the next offset', async t => {
  const root = await fixture(t);
  const tools = await createTools(root, false);
  await writeFile(join(root, 'example.txt'), 'one\ntwo\nthree');
  const window = await tools.execute(
    call('read', { path: 'example.txt', offset: 2, limit: 1 }),
    signal(),
  );
  assert.equal(window.text, '2: two\n[more lines: next offset 3]');
  const whole = await tools.execute(call('read', { path: 'example.txt' }), signal());
  assert.deepEqual(whole, { text: '1: one\n2: two\n3: three', isError: false });
});

test('binary files, directories and large files are rejected; text output is bounded', async t => {
  const root = await fixture(t);
  const tools = await createTools(root, true);
  await writeFile(join(root, 'binary'), Buffer.from([0, 255]));
  await writeFile(join(root, 'large'), 'a'.repeat(2 * 1024 * 1024 + 1));
  await writeFile(join(root, 'text'), 'x'.repeat(40_000));
  for (const path of ['binary', 'large', '.'])
    assert.equal((await tools.execute(call('read', { path }), signal())).isError, true);
  const output = await tools.execute(call('read', { path: 'text' }), signal());
  assert.match(output.text, /truncated/);
  assert.ok(Buffer.byteLength(output.text) < MAX_OUTPUT_BYTES + 100);
});

test('reading a FIFO fails promptly instead of blocking the agent', async t => {
  const root = await fixture(t);
  await promisify(execFile)('mkfifo', [join(root, 'pipe')]);
  const tools = await createTools(root, true);
  const result = await tools.execute(call('read', { path: 'pipe' }), signal());
  assert.equal(result.isError, true);
  assert.match(result.text, /regular text file/);
});
