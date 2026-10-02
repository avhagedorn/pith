import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { projectInstructions } from '../src/instructions.js';
import { MAX_OUTPUT_BYTES } from '../src/tools/shared.js';
import { fixture } from './tools/helpers.js';

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
