import test from 'node:test';
import assert from 'node:assert/strict';
import { detail, duration, markdownStyler, newStats, preview, row, summary } from '../src/render.js';

test('compact rendering: previews, details, rows and summary', async () => {
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
