import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveKey } from '../src/auth.js';
import { SessionLog } from '../src/session.js';

async function fixture(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'pith-auth-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('environment takes precedence, without reading a credential file', async () => {
  assert.deepEqual(await resolveKey({ OPENROUTER_API_KEY: 'env-key' }, '/does/not/exist'), {
    key: 'env-key',
    source: 'OPENROUTER_API_KEY',
  });
});

test('saved OpenRouter key is reused without modifying the Pi file or exposing other providers', async t => {
  const dir = await fixture(t);
  const path = join(dir, 'auth.json');
  const original = JSON.stringify({
    openrouter: { type: 'api_key', key: 'sk-or-test-only' },
    other: { type: 'api_key', key: 'never-used' },
  });
  await writeFile(path, original);
  const result = await resolveKey({}, path);
  assert.equal(result.key, 'sk-or-test-only');
  assert.equal(await readFile(path, 'utf8'), original);
});

test('supports a saved env-var reference; refuses credential commands, OAuth and missing keys', async t => {
  const path = join(await fixture(t), 'auth.json');
  await writeFile(path, JSON.stringify({ openrouter: { type: 'api_key', key: 'MY_ROUTER_KEY' } }));
  assert.equal(
    (await resolveKey({ MY_ROUTER_KEY: 'sk-or-test-only' }, path)).key,
    'sk-or-test-only',
  );
  for (const credential of [
    { type: 'api_key', key: '!echo dangerous' },
    { type: 'oauth', access: 'secret' },
  ]) {
    await writeFile(path, JSON.stringify({ openrouter: credential }));
    await assert.rejects(resolveKey({}, path));
  }
  await assert.rejects(resolveKey({}, '/does/not/exist'), /No OpenRouter/);
});

test('JSONL audit records have private permissions, valid lines, and API key redaction', async t => {
  const dir = join(await fixture(t), 'sessions');
  const log = await SessionLog.create({ model: 'fixed' }, 'sk-or-test-only', dir);
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

test('CLI help needs no credentials and advertises the explicit local-tool flag', async () => {
  const cli = new URL('../src/cli.js', import.meta.url);
  const { stdout, stderr } = await promisify(execFile)(process.execPath, [cli.pathname, '--help'], {
    env: { PATH: process.env.PATH },
  });
  assert.match(stdout, /z-ai\/glm-5\.3-flash/);
  assert.match(stdout, /--allow-local-tools/);
  assert.equal(stderr, '');
});
