import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { createTools } from '../../src/tools/index.js';
import { runShell, shellEnvironment } from '../../src/tools/bash/shell.js';
import { MAX_OUTPUT_BYTES } from '../../src/tools/shared.js';
import { call, fixture, signal } from './helpers.js';

test('bash runs in the workspace and reports the exit status', async t => {
  const root = await fixture(t);
  const tools = await createTools(root);
  const ok = await tools.execute(call('bash', { command: 'echo hi > made.txt && ls' }), signal());
  assert.deepEqual(ok, { text: 'made.txt\n\nexit 0', isError: false });
  assert.deepEqual(await readdir(root), ['made.txt']);
  assert.equal(
    (await tools.execute(call('bash', { command: 'sleep 1', timeout: 121 }), signal())).isError,
    true,
  );
});

test('shell captures exit status, caps both streams, and excludes credential environment', async t => {
  const root = await fixture(t);
  const result = await runShell("printf 'out'; printf 'err' >&2; exit 7", root, signal());
  assert.equal(result.isError, true);
  assert.match(result.text, /out/);
  assert.match(result.text, /err/);
  assert.match(result.text, /exit 7/);
  const env = shellEnvironment({
    PATH: '/bin',
    HOME: root,
    OPENROUTER_API_KEY: 'secret',
    BASH_ENV: '/bad',
    AWS_SECRET_ACCESS_KEY: 'secret',
  });
  assert.equal(env.OPENROUTER_API_KEY, undefined);
  assert.equal(env.BASH_ENV, undefined);
  assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(env.PATH, '/bin');
});

test('shell timeout/cancel stop the process group, including a delayed writer', async t => {
  const root = await fixture(t);
  const timeout = await runShell('(sleep 0.4; echo bad > late.txt) & wait', root, signal(), 50);
  assert.equal(timeout.isError, true);
  assert.match(timeout.text, /Timed out/);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 50);
  const cancelled = await runShell(
    '(sleep 0.4; echo bad > late2.txt) & wait',
    root,
    controller.signal,
  );
  clearTimeout(timer);
  assert.equal(cancelled.isError, true);
  assert.match(cancelled.text, /Cancelled/);
  await new Promise(resolve => setTimeout(resolve, 450));
  assert.deepEqual(await readdir(root), []);
});

test('long output keeps its start and end, and still fits the result cap', async t => {
  const root = await fixture(t);
  const tools = await createTools(root);
  const command = 'echo START; yes x | head -c 100000; echo; echo END; exit 3';
  const result = await tools.execute(call('bash', { command }), signal());
  assert.match(result.text, /^START\n/);
  assert.match(result.text, /\n\[… \d+ bytes truncated …\]\n/);
  assert.match(result.text, /\nEND\n\nexit 3$/);
  assert.ok(Buffer.byteLength(result.text) <= MAX_OUTPUT_BYTES);
  const short = await tools.execute(call('bash', { command: 'echo hi' }), signal());
  assert.equal(short.text, 'hi\n\nexit 0');
});
