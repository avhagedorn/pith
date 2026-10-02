import test from 'node:test';
import assert from 'node:assert/strict';
import type { AssistantMessage, Context, ToolCall } from '@earendil-works/pi-ai';
import { runTurn, type Notice } from '../src/loop.js';
import type { Generate } from '../src/model.js';

const tool = (id = 'one'): ToolCall => ({
  type: 'toolCall',
  id,
  name: 'read',
  arguments: { path: 'example' },
});
function response(
  content: AssistantMessage['content'],
  stopReason: AssistantMessage['stopReason'] = 'stop',
): AssistantMessage {
  return {
    role: 'assistant',
    content,
    stopReason,
    api: 'openai-completions',
    provider: 'openrouter',
    model: 'z-ai/glm-5.3-flash',
    timestamp: 1,
    usage: {
      input: 1,
      output: 1,
      totalTokens: 2,
      cacheRead: 0,
      cacheWrite: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}
const final = () => response([{ type: 'text', text: 'done' }]);
function fixture(replies: AssistantMessage[]) {
  const context: Context = { systemPrompt: 'test', messages: [] };
  const events: Record<string, unknown>[] = [];
  const notices: Notice[] = [];
  const seen: Context[] = [];
  const executed: string[] = [];
  const controller = new AbortController();
  const generate: Generate = async (ctx, _signal, onText) => {
    seen.push(structuredClone(ctx));
    const reply = replies.shift();
    if (!reply) throw new Error('No scripted response');
    for (const block of reply.content) if (block.type === 'text') onText(block.text);
    return reply;
  };
  const options = {
    prompt: 'do it',
    maxSteps: 20,
    context,
    generate,
    signal: controller.signal,
    record: async (e: Record<string, unknown>) => {
      events.push(structuredClone(e));
    },
    onProgress: (n: Notice) => {
      notices.push(n);
    },
    tools: {
      definitions: [],
      execute: async (call: ToolCall) => {
        executed.push(call.id);
        return { text: 'ok', isError: false };
      },
    },
  };
  return { context, events, notices, seen, executed, controller, options };
}

test('text-only completes without tool execution', async () => {
  const f = fixture([final()]);
  assert.equal((await runTurn(f.options)).reason, 'complete');
  assert.deepEqual(f.executed, []);
  assert.deepEqual(
    f.context.messages.map(m => m.role),
    ['user', 'assistant'],
  );
});

test('tool batch is sequential, recorded before execution, and reasoning survives continuation', async () => {
  const thinking = { type: 'thinking' as const, thinking: 'trace', thinkingSignature: 'opaque' };
  const first = response([thinking, tool('one'), tool('two')], 'toolUse');
  const f = fixture([first, final()]);
  f.options.tools.execute = async call => {
    const last = f.events.at(-1);
    assert.equal(last?.type, 'tool_started');
    assert.equal(last?.callId, call.id);
    f.executed.push(call.id);
    return { text: 'ok', isError: false };
  };
  assert.equal((await runTurn(f.options)).reason, 'complete');
  assert.deepEqual(f.executed, ['one', 'two']);
  assert.deepEqual(f.seen[1]?.messages[1], first);
  const results = f.seen[1]?.messages.filter(m => m.role === 'toolResult');
  assert.deepEqual(
    results?.map(m => m.toolCallId),
    ['one', 'two'],
  );
});

test('tool exception becomes a matching error result and the model can recover', async () => {
  const f = fixture([response([tool()], 'toolUse'), final()]);
  f.options.tools.execute = async () => {
    throw new Error('failed edit');
  };
  assert.equal((await runTurn(f.options)).reason, 'complete');
  const result = f.context.messages[2];
  assert.equal(result?.role, 'toolResult');
  if (result?.role === 'toolResult') {
    assert.equal(result.isError, true);
    assert.equal(result.toolCallId, 'one');
  }
});

test('aborted/error/length responses never execute partially received tools', async () => {
  for (const reason of ['aborted', 'error', 'length', 'pending', 'deferred'] as const) {
    const f = fixture([response([tool()], reason)]);
    const result = await runTurn(f.options);
    assert.notEqual(result.reason, 'complete');
    assert.deepEqual(f.executed, []);
    assert.equal(f.context.messages.length, 1);
    assert.ok(f.events.some(e => e.type === 'incomplete_response'));
  }
});

test('cancellation during first tool settles every call ID without running remaining tools', async () => {
  const f = fixture([response([tool('one'), tool('two')], 'toolUse')]);
  f.options.tools.execute = async call => {
    f.executed.push(call.id);
    f.controller.abort();
    return { text: 'interrupted', isError: true };
  };
  assert.equal((await runTurn(f.options)).reason, 'aborted');
  assert.deepEqual(f.executed, ['one']);
  const results = f.context.messages.filter(m => m.role === 'toolResult');
  assert.deepEqual(
    results.map(m => m.toolCallId),
    ['one', 'two'],
  );
  assert.ok(results.every(m => m.isError));
});

test('step/input limits are visible stops, not success', async () => {
  const f = fixture([response([tool()], 'toolUse')]);
  assert.equal((await runTurn({ ...f.options, maxSteps: 1 })).reason, 'limit');
  assert.equal(f.context.messages.at(-1)?.role, 'toolResult');
  const g = fixture([final()]);
  assert.equal((await runTurn({ ...g.options, maxContextBytes: 1 })).reason, 'limit');
  assert.equal(g.seen.length, 0);
});

test('duplicate IDs and empty toolUse are rejected before tools/history mutation', async () => {
  for (const reply of [response([tool(), tool()], 'toolUse'), response([], 'toolUse')]) {
    const f = fixture([reply]);
    assert.equal((await runTurn(f.options)).reason, 'error');
    assert.deepEqual(f.executed, []);
    assert.equal(f.context.messages.length, 1);
  }
});

test('provider exceptions become visible errors with no tools', async () => {
  const f = fixture([]);
  assert.equal((await runTurn(f.options)).reason, 'error');
  assert.deepEqual(f.executed, []);
});

test('disk failure before the execution marker prevents tool execution', async () => {
  const f = fixture([response([tool()], 'toolUse')]);
  const record = f.options.record;
  f.options.record = async event => {
    if (event.type === 'tool_started') throw new Error('disk full');
    await record(event);
  };
  await assert.rejects(runTurn(f.options), /disk full/);
  assert.deepEqual(f.executed, []);
});
