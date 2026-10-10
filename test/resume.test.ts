import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { listSessions, readConversation } from '../src/session.js';
import { fixture } from './tools/helpers.js';

const line = (event: Record<string, unknown>) => `${JSON.stringify(event)}\n`;
const user = (content: string) => ({ type: 'message', message: { role: 'user', content } });
const call = { type: 'toolCall', id: 'c1', name: 'read', arguments: { path: 'a' } };

test('sessions are listed for this workspace only, newest first, after any reset', async t => {
  const dir = await fixture(t);
  const write = (name: string, cwd: string, ...events: Record<string, unknown>[]) =>
    writeFile(join(dir, name), line({ type: 'session', cwd }) + events.map(line).join(''));
  await write('1.jsonl', '/repo', user('old question'), { type: 'context_reset' }, user('first'));
  await new Promise(resolve => setTimeout(resolve, 20));
  await write('2.jsonl', '/repo', user('newer'), user('second prompt'));
  await write('3.jsonl', '/elsewhere', user('not this repo'));
  await write('4.jsonl', '/repo'); // nothing asked

  const sessions = await listSessions('/repo', dir);
  assert.deepEqual(
    sessions.map(s => [s.label, s.prompts]),
    [
      ['newer', 2],
      ['first', 1],
    ],
  );
});

test('a log that ended mid-turn is repaired so every tool call has a result', async t => {
  const path = join(await fixture(t), 'crashed.jsonl');
  const assistant = { role: 'assistant', content: [call, { ...call, id: 'c2' }] };
  const done = {
    role: 'toolResult',
    toolCallId: 'c1',
    toolName: 'read',
    content: [],
    isError: false,
  };
  await writeFile(
    path,
    line({ type: 'session', cwd: '/repo' }) +
      line(user('go')) +
      line({ type: 'message', message: assistant }) +
      line({ type: 'message', message: done }) +
      line({ type: 'tool_started', callId: 'c2' }),
  );
  const messages = await readConversation(path, '/repo');
  assert.equal(messages.length, 4);
  const repaired = messages.at(-1);
  assert.ok(repaired?.role === 'toolResult' && repaired.toolCallId === 'c2' && repaired.isError);
  assert.deepEqual(await readConversation(path, '/other'), []);
});
