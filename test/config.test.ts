import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig, projectInstructions, redact } from '../src/config.js';
import { MAX_OUTPUT_BYTES } from '../src/tools/shared.js';
import { fixture } from './tools/helpers.js';

test('config must exist, be private and hold an OpenRouter key; the Exa key is optional', async t => {
  const path = join(await fixture(t), 'config.json');
  await assert.rejects(loadConfig(path), /No config/);

  await writeFile(path, JSON.stringify({ openrouterApiKey: ' sk-or-x ', exaApiKey: '', other: 1 }));
  await chmod(path, 0o644);
  await assert.rejects(loadConfig(path), /chmod 600/);
  await chmod(path, 0o600);
  assert.deepEqual(await loadConfig(path), { openrouterApiKey: 'sk-or-x', exaApiKey: undefined });

  await writeFile(path, JSON.stringify({ openrouterApiKey: 'sk-or-x', exaApiKey: 'exa-y' }));
  assert.equal((await loadConfig(path)).exaApiKey, 'exa-y');

  await writeFile(path, JSON.stringify({ exaApiKey: 'exa-y' }));
  await assert.rejects(loadConfig(path), /Add "openrouterApiKey"/);
  await writeFile(path, '{ not json');
  await assert.rejects(loadConfig(path), /not valid JSON/);
});

test('every secret is redacted, and missing ones are ignored', () => {
  const secrets = ['KEY1', undefined, '', 'KEY2'];
  assert.equal(redact('a KEY1 b KEY2 c', secrets), 'a [REDACTED] b [REDACTED] c');
});

test('AGENTS.md is loaded from the workspace root when present', async t => {
  const root = await fixture(t);
  assert.equal(await projectInstructions(root), undefined);
  await writeFile(join(root, 'AGENTS.md'), '\nUse pnpm.\n\n');
  assert.equal(await projectInstructions(root), 'Use pnpm.');
  await writeFile(join(root, 'AGENTS.md'), '   \n');
  assert.equal(await projectInstructions(root), undefined);
});

test('an oversized AGENTS.md is capped and an unreadable one is an error', async t => {
  const root = await fixture(t);
  await writeFile(join(root, 'AGENTS.md'), 'x'.repeat(MAX_OUTPUT_BYTES * 2));
  const capped = await projectInstructions(root);
  assert.match(capped ?? '', /truncated/);
  assert.ok(Buffer.byteLength(capped ?? '') < MAX_OUTPUT_BYTES + 100);

  const other = await fixture(t);
  await mkdir(join(other, 'AGENTS.md'));
  await assert.rejects(projectInstructions(other), /Cannot read AGENTS.md/);
});
