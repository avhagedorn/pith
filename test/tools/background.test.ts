import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import type { ToolCall } from '@earendil-works/pi-ai';
import { hasPty } from '../../src/tools/background/pty.js';
import { createTools } from '../../src/tools/index.js';
import { call, fixture, signal } from './helpers.js';

// Jobs are driven through the same ToolSet the loop uses, so validation and error wrapping count.
async function setup(t: test.TestContext) {
  const tools = await createTools(await fixture(t));
  t.after(() => tools.jobs.stopAll());
  const run = (args: ToolCall['arguments']) => tools.execute(call('background', args), signal());
  // Jobs are unref'd so they never keep pith alive, so something else must while we wait.
  const ended = async () => {
    const keepAlive = setInterval(() => {}, 1000);
    await new Promise<void>(resolve => tools.jobs.onEnd(resolve));
    clearInterval(keepAlive);
  };
  return { tools, run, ended };
}

const have = (name: string) =>
  spawnSync('/bin/sh', ['-c', `command -v ${name}`], { stdio: 'ignore' }).status === 0;
const bufferedOutputIsTestable = () => hasPty() && have('perl');

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test('a job that ends unseen leaves one notice with its status and output', async t => {
  const { tools, run, ended } = await setup(t);
  const finished = ended();
  const started = await run({ action: 'start', command: 'echo hello; exit 3' });
  assert.equal(started.isError, false);
  assert.match(started.text, /Started background job 1/);

  await finished;
  assert.equal(tools.jobs.pending(), true);
  const notices = await tools.jobs.drain();
  assert.equal(notices.length, 1);
  assert.match(notices[0]!, /^Background job 1 exited 3 after under 1s: echo hello; exit 3/);
  assert.match(notices[0]!, /<job-output>\nhello\n<\/job-output>/);
  assert.equal(tools.jobs.pending(), false);
  assert.deepEqual(await tools.jobs.drain(), []);
});

test('check with wait blocks until the job exits, and then no notice is due', async t => {
  const { tools, run } = await setup(t);
  await run({ action: 'start', command: 'sleep 0.2; echo done' });
  const result = await run({ action: 'check', id: 1, wait: 10 });
  assert.match(result.text, /^Background job 1 exited 0/);
  assert.match(result.text, /done/);
  assert.equal(tools.jobs.pending(), false);
});

test('check shows only output since the last check', async t => {
  const { run } = await setup(t);
  await run({ action: 'start', command: 'echo one; sleep 0.3; echo two; sleep 60' });
  await wait(150);
  const first = await run({ action: 'check', id: 1 });
  assert.match(first.text, /running for/);
  assert.match(first.text, /^one$/m);
  await wait(300);
  const second = await run({ action: 'check', id: 1 });
  assert.doesNotMatch(second.text, /^one$/m);
  assert.match(second.text, /^two$/m);
  const third = await run({ action: 'check', id: 1 });
  assert.match(third.text, /\(no new output\)/);
});

test('kill stops the job and its children, without a notice', async t => {
  const { tools, run } = await setup(t);
  await run({ action: 'start', command: 'sleep 60 & echo $!; wait' });
  await wait(150);
  const pid = Number((await run({ action: 'check', id: 1 })).text.match(/^(\d+)$/m)![1]);
  assert.ok(alive(pid));

  const killed = await run({ action: 'kill', id: 1 });
  assert.match(killed.text, /killed by SIGTERM/);
  assert.equal(alive(pid), false);
  assert.equal(tools.jobs.pending(), false);
});

test('stopAll kills running jobs', async t => {
  const { tools, run } = await setup(t);
  await run({ action: 'start', command: 'sleep 60 & echo $!; wait' });
  await wait(150);
  const pid = Number((await run({ action: 'check', id: 1 })).text.match(/^(\d+)$/m)![1]);
  tools.jobs.stopAll();
  await wait(100);
  assert.equal(alive(pid), false);
});

test('check without an id lists every job', async t => {
  const { run } = await setup(t);
  assert.match((await run({ action: 'check' })).text, /No background jobs/);
  await run({ action: 'start', command: 'sleep 60' });
  await run({ action: 'start', command: 'true' });
  const list = (await run({ action: 'check' })).text.split('\n');
  assert.equal(list.length, 2);
  assert.match(list[0]!, /^Background job 1 running for .*: sleep 60$/);
});

test('bad background calls come back as error results', async t => {
  const { run } = await setup(t);
  for (const args of <ToolCall['arguments'][]>[
    { action: 'start' },
    { action: 'kill' },
    { action: 'check', id: 9 },
    { action: 'check', id: 'one' },
    { action: 'check', id: 1, wait: 9999 },
    { action: 'kill', id: 1, signal: 'SIGFOO' },
  ]) {
    assert.equal((await run(args)).isError, true, JSON.stringify(args));
  }
});

test('check with until returns as soon as the log matches', async t => {
  const { run } = await setup(t);
  await run({ action: 'start', command: 'sleep 0.2; echo "Listening on port 3000"; sleep 60' });
  const started = Date.now();
  const checked = await run({ action: 'check', id: 1, until: 'Listening on port 3000', wait: 10 });
  assert.ok(Date.now() - started < 5_000, 'it should not have waited out the timeout');
  assert.match(checked.text, /Matched \/Listening on port 3000\/ after/);
  assert.match(checked.text, /^Listening on port 3000$/m);
});

test('check with until reports a timeout and leaves the job running', async t => {
  const { tools, run } = await setup(t);
  await run({ action: 'start', command: 'sleep 60' });
  const checked = await run({ action: 'check', id: 1, until: 'never', wait: 1 });
  assert.match(checked.text, /No match for \/never\/ after 1s; the job is still running/);
  assert.equal(tools.jobs.pending(), false);
});

test('check with until says so when the job ends without matching', async t => {
  const { run } = await setup(t);
  await run({ action: 'start', command: 'echo out; exit 2' });
  const checked = await run({ action: 'check', id: 1, until: 'nope', wait: 10 });
  assert.match(checked.text, /No match for \/nope\/ after .* the job has ended/);
  assert.match(checked.text, /^out$/m);
});

test('a bad until pattern comes back as an error result', async t => {
  const { run } = await setup(t);
  await run({ action: 'start', command: 'sleep 60' });
  const bad = await run({ action: 'check', id: 1, until: '(' });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /Bad regex for "until"/);
});

test('kill takes the signal it is given, with no escalation', async t => {
  const { run } = await setup(t);
  await run({ action: 'start', command: 'sleep 60' });
  await wait(150);
  const killed = await run({ action: 'kill', id: 1, signal: 'SIGKILL' });
  assert.match(killed.text, /killed by SIGKILL after/);
  assert.doesNotMatch(killed.text, /ignored/);
});

test('kill escalates to SIGKILL when the job ignores the signal', async t => {
  const { run } = await setup(t);
  await run({ action: 'start', command: "trap '' TERM; while :; do sleep 1; done" });
  await wait(150);
  const killed = await run({ action: 'kill', id: 1 });
  assert.match(killed.text, /killed by SIGKILL \(SIGTERM ignored\)/);
});

test('a line-buffered program reaches the log while it runs', async t => {
  const { run } = await setup(t);
  if (!bufferedOutputIsTestable()) return t.skip('needs script(1) and perl');
  // perl block-buffers stdout on a pipe, so on a pipe this line would sit in the buffer
  await run({ action: 'start', command: String.raw`perl -e '$| = 0; print "ready\n"; sleep 60'` });
  const checked = await run({ action: 'check', id: 1, until: 'ready', wait: 10 });
  assert.match(checked.text, /Matched \/ready\/ after/);
  assert.match(checked.text, /^ready$/m);
});
