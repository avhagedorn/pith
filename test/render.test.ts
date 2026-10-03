import test from 'node:test';
import assert from 'node:assert/strict';
import { contextUse, detail, duration, newStats, preview, row, summary } from '../src/render.js';

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
  assert.equal(
    detail(call('bash', {}), { text: 'a\nb\n\nexit 0', isError: false }, 2400),
    '2 lines · 2s',
  );
  assert.equal(detail(call('bash', {}), { text: 'boom\nexit 1', isError: true }, 10), 'exit 1');
  assert.equal(
    detail(
      call('edit', { oldText: 'a\nb', newText: 'c\n' }),
      { text: 'Edited', isError: false },
      0,
    ),
    '+1/-2',
  );
  assert.equal(
    detail(call('write', { content: 'a\nb\n' }), { text: 'Wrote', isError: false }, 0),
    '+2/-0',
  );
  assert.equal(
    detail(
      call('edit', { oldText: 'a', newText: 'b' }),
      { text: 'oldText not found.', isError: true },
      0,
    ),
    'oldText not found.',
  );
  assert.equal(duration(999), '');
  assert.equal(duration(125_000), '2m5s');
  assert.equal(row('$ echo   hi\nthere {1 line}', 'ok', false, 80), '◆ $ echo hi there {1 line}');
  assert.equal(row('thinking', 'wait', false, 80), '◇ thinking');
  assert.equal(row('x'.repeat(50), 'error', false, 12), `✗ ${'x'.repeat(9)}…`);
  assert.match(
    row('edit a {+1/-2}', 'ok', true, 80),
    /^\x1b\[32m◆\x1b\[0m .*\x1b\[32m\+1.*\x1b\[31m-2/,
  );
  const stats = newStats();
  stats.reads.add('a').add('b');
  stats.edits.add('a');
  stats.commands = 3;
  stats.failed = 1;
  stats.cost = 0.00091;
  assert.equal(
    summary(stats, 42_000),
    'Read 2 files, edited 1 file, ran 3 commands, 1 failed · 42s · ~$0.0009',
  );
  assert.equal(summary(newStats(), 10), '~$0.0000');
  assert.equal(contextUse(12_345, 0.094), 'context 9% (12k tokens)');
  assert.equal(contextUse(2_500, 0.5), 'context 50% (2.5k tokens)');
  assert.equal(
    summary(newStats(), 10, 'context 1% (900 tokens)'),
    '~$0.0000 · context 1% (900 tokens)',
  );
});
