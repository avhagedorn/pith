import test from 'node:test';
import assert from 'node:assert/strict';
import { markdownStyler } from '../src/markdown.js';

test('markdown styling is line-at-a-time and off without color', async () => {
  assert.deepEqual(markdownStyler(false).push('| a | `x` |'), ['| a | `x` |']);
  const styler = markdownStyler(true);
  const style = (line: string) => styler.push(line).join('\n');
  const B = '\x1b[1m',
    b = '\x1b[22m',
    I = '\x1b[3m',
    i = '\x1b[23m',
    D = '\x1b[2m';
  assert.equal(style('## Result for `add`'), '\x1b[1;33mResult for add\x1b[0m');
  assert.equal(
    style('  - use **bold** and `code`'),
    `  • use ${B}bold${b} and \x1b[36mcode\x1b[39m`,
  );
  assert.equal(
    style('__bold__ *it* _it_ ***both*** ~~gone~~'),
    `${B}bold${b} ${I}it${i} ${I}it${i} \x1b[1;3mboth\x1b[22;23m \x1b[9mgone\x1b[29m`,
  );
  assert.equal(style('**a *nested* b**'), `${B}a ${I}nested${i} b${b}`);
  assert.equal(
    style('snake_case_name, 2 * 3 * 4, a*b and a_b stay'),
    'snake_case_name, 2 * 3 * 4, a*b and a_b stay',
  );
  assert.equal(
    style('`**raw** _x_` and \\*escaped\\*'),
    '\x1b[36m**raw** _x_\x1b[39m and *escaped*',
  );
  assert.equal(
    style('see [the docs](https://x.dev/a_b_c)'),
    `see \x1b[4mthe docs\x1b[24m ${D}(https://x.dev/a_b_c)${b}`,
  );
  assert.equal(style('> quoted **text**'), `${D}│${b} ${I}quoted ${B}text${b}${i}`);
  assert.equal(style('---'), `${D}${'─'.repeat(40)}${b}`);
  assert.equal(style('1. first'), '1. first');
  assert.equal(style('```ts'), `${D}\`\`\`ts${b}`);
  assert.equal(
    style('const a = `**x**`; # not a heading'),
    '\x1b[36mconst a = `**x**`; # not a heading\x1b[0m',
  );
  assert.equal(style('```'), `${D}\`\`\`${b}`);
  assert.equal(style('**after**'), `${B}after${b}`);
});

test('tables are held until they end, then printed with aligned columns', () => {
  const styler = markdownStyler(true);
  const B = '\x1b[1m',
    b = '\x1b[22m',
    D = '\x1b[2m';
  const rows = [
    '| File | Lines | Role |',
    '|---|---:|:--|',
    '| cli.ts | 204 | entry |',
    '| a.ts | 3 | `x \\| y` |',
  ];
  for (const row of rows) assert.deepEqual(styler.push(row), []);
  assert.deepEqual(styler.push('after'), [
    `${B}File${b}    ${B}Lines${b}  ${B}Role${b}`,
    `${D}──────  ─────  ─────${b}`,
    'cli.ts    204  entry',
    'a.ts        3  \x1b[36mx | y\x1b[39m',
    'after',
  ]);

  // No divider row: no header. A missing cell is padded, and flush releases what is held.
  styler.push('| a | bb |');
  styler.push('| ccc |');
  assert.deepEqual(styler.flush(), ['a    bb', 'ccc']);
  assert.deepEqual(styler.flush(), []);

  // Inside a code fence a pipe is just text.
  styler.push('```');
  assert.deepEqual(styler.push('| not | a table |'), ['\x1b[36m| not | a table |\x1b[0m']);
});

test('a table too wide for the terminal becomes header: value lines', () => {
  const styler = markdownStyler(true, () => 30);
  const B = '\x1b[1m',
    b = '\x1b[22m';
  styler.push('| # | Why |');
  styler.push('|---|---|');
  styler.push('| 1 | the quick **brown fox** jumps over the lazy dog |');
  styler.push('| 2 | short |');
  assert.deepEqual(styler.flush(), [
    `${B}#${b}: 1`,
    `${B}Why${b}: the quick ${B}brown fox${b} jumps over the lazy dog`,
    '',
    `${B}#${b}: 2`,
    `${B}Why${b}: short`,
  ]);

  // The same table with room to spare stays a grid.
  const wide = markdownStyler(true, () => 80);
  wide.push('| # | Why |');
  wide.push('|---|---|');
  wide.push('| 2 | short |');
  assert.equal(wide.flush().at(-1), '2  short');
});
