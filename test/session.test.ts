import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { SessionLog } from '../src/session.js';

async function fixture(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'pith-auth-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('JSONL audit records have private permissions, valid lines, and API key redaction', async t => {
  const dir = join(await fixture(t), 'sessions');
  const log = await SessionLog.create({ model: 'fixed' }, ['sk-or-test-only'], dir);
  await log.record({ type: 'tool_started', callId: 'one' });
  await log.record({ type: 'message', content: 'oops sk-or-test-only' });
  await log.close();
  const text = await readFile(log.path, 'utf8');
  assert.ok(!text.includes('sk-or-test-only'));
  assert.match(text, /REDACTED/);
  const entries = text
    .trim()
    .split('\n')
    .map(line => JSON.parse(line));
  assert.deepEqual(
    entries.map(e => e.type),
    ['session', 'tool_started', 'message'],
  );
  assert.equal((await stat(log.path)).mode & 0o777, 0o600);
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
});

test('CLI help needs no config and warns that bash is unsandboxed', async () => {
  const cli = new URL('../src/cli.js', import.meta.url);
  const { stdout, stderr } = await promisify(execFile)(process.execPath, [cli.pathname, '--help'], {
    env: { PATH: process.env.PATH },
  });
  assert.match(stdout, /z-ai\/glm-5\.3-flash/);
  assert.match(stdout, /NOT sandboxed/);
  assert.equal(stderr, '');
});
