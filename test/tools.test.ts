import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, symlink, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createTools, workspacePath } from '../src/tools.js';
import { runShell, shellEnvironment, MAX_OUTPUT_BYTES } from '../src/shell.js';
import type { ToolCall } from '@earendil-works/pi-ai';

const signal = () => new AbortController().signal;
const call = (name: string, args: ToolCall['arguments']): ToolCall => ({
  type: 'toolCall',
  id: 'test',
  name,
  arguments: args,
});
async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'pith-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('four tools only when local execution is explicitly enabled', async t => {
  const root = await fixture(t);
  const readonly = await createTools(root, false);
  assert.deepEqual(
    readonly.definitions.map(t => t.name),
    ['read'],
  );
  assert.equal((await readonly.execute(call('bash', { command: 'echo denied' }), signal())).isError, true);
  assert.deepEqual(
    (await createTools(root, true)).definitions.map(t => t.name),
    ['read', 'write', 'edit', 'bash'],
  );
});

test('read, create, exact edit, and preserving file modes', async t => {
  const root = await fixture(t);
  const tools = await createTools(root, true);
  assert.equal(
    (await tools.execute(call('write', { path: 'nested/example.txt', content: 'one\ntwo\nthree' }), signal())).isError,
    false,
  );
  const read = await tools.execute(call('read', { path: 'nested/example.txt', offset: 2, limit: 1 }), signal());
  assert.match(read.text, /^2: two\n\[more lines: next offset 3\]/);
  const edit = await tools.execute(
    call('edit', { path: 'nested/example.txt', oldText: 'two', newText: 'TWO' }),
    signal(),
  );
  assert.equal(edit.isError, false);
  assert.equal(await readFile(join(root, 'nested/example.txt'), 'utf8'), 'one\nTWO\nthree');
  assert.deepEqual(await readdir(join(root, 'nested')), ['example.txt']);
  assert.equal((await stat(join(root, 'nested/example.txt'))).mode & 0o777, 0o600);
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
  assert.deepEqual(await readdir(outside), ['secret.txt']);
  // root returned by createTools is canonicalized (/var vs /private/var on macOS).
  const { realpath } = await import('node:fs/promises');
  const canonical = await realpath(root);
  assert.equal(await workspacePath(canonical, 'new/a.txt'), join(canonical, 'new/a.txt'));
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

test('already-cancelled operations do not write files', async t => {
  const root = await fixture(t);
  const tools = await createTools(root, true);
  const controller = new AbortController();
  controller.abort();
  assert.equal(
    (await tools.execute(call('write', { path: 'no.txt', content: 'no' }), controller.signal)).isError,
    true,
  );
  assert.deepEqual(await readdir(root), []);
});

test('shell captures exit status, caps both streams, and excludes credential environment', async t => {
  const root = await fixture(t);
  const result = await runShell("printf 'out'; printf 'err' >&2; exit 7", root, signal());
  assert.equal(result.isError, true);
  assert.match(result.text, /out/);
  assert.match(result.text, /err/);
  assert.match(result.text, /exit 7/);
  const huge = await runShell('yes x | head -c 100000', root, signal());
  assert.match(huge.text, /truncated/);
  assert.ok(Buffer.byteLength(huge.text) < MAX_OUTPUT_BYTES + 150);
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
  const cancelled = await runShell('(sleep 0.4; echo bad > late2.txt) & wait', root, controller.signal);
  clearTimeout(timer);
  assert.equal(cancelled.isError, true);
  assert.match(cancelled.text, /Cancelled/);
  await new Promise(resolve => setTimeout(resolve, 450));
  assert.deepEqual(await readdir(root), []);
});

test('compact rendering: previews, details, rows and summary', async () => {
  const { detail, duration, newStats, preview, row, summary } = await import('../src/render.js');
  const call = (name: string, args: Record<string, string | number>) => ({
    type: 'toolCall' as const,
    id: 'x',
    name,
    arguments: args,
  });
  assert.equal(preview(call('bash', { command: 'ls -la' })), '$ ls -la');
  assert.equal(preview(call('read', { path: 'a.ts', offset: 10, limit: 20 })), 'read a.ts:10-29');
  assert.equal(preview(call('edit', { path: 'a.ts', oldText: 'a', newText: 'b' })), 'edit a.ts');
  assert.equal(detail(call('bash', {}), { text: 'a\nb\n\nexit 0', isError: false }, 2400), '2 lines · 2s');
  assert.equal(detail(call('bash', {}), { text: 'boom\nexit 1', isError: true }, 10), 'exit 1');
  assert.equal(
    detail(call('edit', { oldText: 'a\nb', newText: 'c\n' }), { text: 'Edited', isError: false }, 0),
    '+1/-2',
  );
  assert.equal(detail(call('write', { content: 'a\nb\n' }), { text: 'Wrote', isError: false }, 0), '+2/-0');
  assert.equal(
    detail(call('edit', { oldText: 'a', newText: 'b' }), { text: 'oldText not found.', isError: true }, 0),
    'oldText not found.',
  );
  assert.equal(duration(999), '');
  assert.equal(duration(125_000), '2m5s');
  assert.equal(row('$ echo   hi\nthere {1 line}', 'ok', false, 80), '◆ $ echo hi there {1 line}');
  assert.equal(row('x'.repeat(50), 'error', false, 12), `✗ ${'x'.repeat(9)}…`);
  assert.match(row('edit a {+1/-2}', 'ok', true, 80), /^\x1b\[32m◆\x1b\[0m .*\x1b\[32m\+1.*\x1b\[31m-2/);
  const stats = newStats();
  stats.reads.add('a').add('b');
  stats.edits.add('a');
  stats.commands = 3;
  stats.failed = 1;
  stats.cost = 0.00091;
  assert.equal(summary(stats, 42_000), 'Read 2 files, edited 1 file, ran 3 commands, 1 failed · 42s · ~$0.0009');
  assert.equal(summary(newStats(), 10), '~$0.0000');
});

test('markdown styling is line-at-a-time and off without color', async () => {
  const { markdownStyler } = await import('../src/render.js');
  const plain = markdownStyler(false);
  assert.equal(plain('## **Hi** `x`'), '## **Hi** `x`');
  const style = markdownStyler(true);
  const B = '\x1b[1m',
    b = '\x1b[22m',
    I = '\x1b[3m',
    i = '\x1b[23m',
    D = '\x1b[2m';
  assert.equal(style('## Result for `add`'), '\x1b[1;33mResult for add\x1b[0m');
  assert.equal(style('  - use **bold** and `code`'), `  • use ${B}bold${b} and \x1b[36mcode\x1b[39m`);
  assert.equal(
    style('__bold__ *it* _it_ ***both*** ~~gone~~'),
    `${B}bold${b} ${I}it${i} ${I}it${i} \x1b[1;3mboth\x1b[22;23m \x1b[9mgone\x1b[29m`,
  );
  assert.equal(style('**a *nested* b**'), `${B}a ${I}nested${i} b${b}`);
  assert.equal(style('snake_case_name, 2 * 3 * 4, a*b and a_b stay'), 'snake_case_name, 2 * 3 * 4, a*b and a_b stay');
  assert.equal(style('`**raw** _x_` and \\*escaped\\*'), '\x1b[36m**raw** _x_\x1b[39m and *escaped*');
  assert.equal(
    style('see [the docs](https://x.dev/a_b_c)'),
    `see \x1b[4mthe docs\x1b[24m ${D}(https://x.dev/a_b_c)${b}`,
  );
  assert.equal(style('> quoted **text**'), `${D}│${b} ${I}quoted ${B}text${b}${i}`);
  assert.equal(style('---'), `${D}${'─'.repeat(40)}${b}`);
  assert.equal(style('| a | **b** |'), `${D}│${b} a ${D}│${b} ${B}b${b} ${D}│${b}`);
  assert.equal(style('|---|:-:|'), `${D}│───│───│${b}`);
  assert.equal(style('1. first'), '1. first');
  assert.equal(style('```ts'), `${D}\`\`\`ts${b}`);
  assert.equal(style('const a = `**x**`; # not a heading'), '\x1b[36mconst a = `**x**`; # not a heading\x1b[0m');
  assert.equal(style('```'), `${D}\`\`\`${b}`);
  assert.equal(style('**after**'), `${B}after${b}`);
});
