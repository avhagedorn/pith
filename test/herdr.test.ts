import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { herdrReporter } from '../src/herdr.js';
import { fixture } from './tools/helpers.js';

test('inside herdr, session and state reports go to its socket in order', async t => {
  const socketPath = join(await fixture(t), 'herdr.sock');
  const received: Record<string, any>[] = [];
  const server = createServer(socket =>
    socket.on('data', data => {
      received.push(JSON.parse(String(data)));
      socket.end('{"ok":true}\n');
    }),
  );
  await new Promise<void>(resolve => server.listen(socketPath, resolve));
  t.after(() => server.close());

  const herdr = herdrReporter({
    HERDR_ENV: '1',
    HERDR_SOCKET_PATH: socketPath,
    HERDR_PANE_ID: 'p1',
  });
  await herdr.session('/logs/a.jsonl');
  herdr.state('working');
  await herdr.state('idle');

  assert.deepEqual(
    received.map(r => [r.method, r.params.state ?? r.params.agent_session_path]),
    [
      ['pane.report_agent_session', '/logs/a.jsonl'],
      ['pane.report_agent', 'working'],
      ['pane.report_agent', 'idle'],
    ],
  );
  assert.ok(received.every(r => r.params.pane_id === 'p1' && r.params.agent === 'pith'));
  assert.ok(received[1]!.params.seq < received[2]!.params.seq);
});

test('outside herdr, or with herdr gone, reporting is a silent no-op', async t => {
  await herdrReporter({}).state('working');
  const missing = join(await fixture(t), 'nothing-here.sock');
  await herdrReporter({ HERDR_ENV: '1', HERDR_SOCKET_PATH: missing, HERDR_PANE_ID: 'p1' }).state(
    'idle',
  );
});
