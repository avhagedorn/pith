import type { Context, Message, ToolCall, ToolResultMessage, Usage } from '@earendil-works/pi-ai';
import type { Generate } from './model.js';
import type { RecordEvent } from './session.js';
import type { ToolOutput, ToolSet } from './tools.js';

export const MAX_CONTEXT_BYTES = 512 * 1024;
export const MAX_STEPS = 20;
export type Notice =
  | { type: 'request'; step: number }
  | { type: 'text'; text: string }
  | { type: 'tool-start'; call: ToolCall }
  | { type: 'tool-end'; call: ToolCall; result: ToolOutput }
  | { type: 'usage'; usage: Usage };
export interface RunOutcome { reason: 'complete' | 'aborted' | 'limit' | 'error'; detail: string }

export async function runTurn(options: {
  prompt: string;
  context: Context;
  generate: Generate;
  tools: ToolSet;
  record: RecordEvent;
  notify: (notice: Notice) => void;
  signal: AbortSignal;
  maxSteps?: number;
  maxContextBytes?: number;
}): Promise<RunOutcome> {
  const { prompt, context, generate, tools, record, notify, signal } = options;
  const append = async (message: Message) => {
    await record({ type: 'message', message });
    context.messages.push(message);
  };
  const finish = async (reason: RunOutcome['reason'], detail: string): Promise<RunOutcome> => {
    await record({ type: 'run_end', reason, detail });
    return { reason, detail };
  };
  if (signal.aborted) return finish('aborted', 'Cancelled before starting.');
  await append({ role: 'user', content: prompt, timestamp: Date.now() });

  for (let step = 1; step <= (options.maxSteps ?? MAX_STEPS); step++) {
    if (signal.aborted) return finish('aborted', 'Cancelled.');
    if (Buffer.byteLength(JSON.stringify(context)) > (options.maxContextBytes ?? MAX_CONTEXT_BYTES)) {
      return finish('limit', 'Transcript reached the 512 KiB input cap. Start a new session; v0 does not compact.');
    }
    notify({ type: 'request', step });
    // Provider/setup exceptions must not execute partially streamed calls.
    let response;
    try { response = await generate(context, signal, text => notify({ type: 'text', text })); }
    catch (error) {
      return finish(signal.aborted ? 'aborted' : 'error', error instanceof Error ? error.message : String(error));
    }
    notify({ type: 'usage', usage: response.usage });
    if (signal.aborted || !['stop', 'toolUse'].includes(response.stopReason)) {
      await record({ type: 'incomplete_response', response }); // audit, not model history
      return finish(signal.aborted ? 'aborted' : 'error', response.errorMessage || `Model stopped with ${response.stopReason}; no tools from this response were executed.`);
    }
    const calls = response.content.filter((block): block is ToolCall => block.type === 'toolCall');
    const ids = new Set(calls.map(call => call.id));
    if (ids.size !== calls.length || calls.some(call => !call.id) || (response.stopReason === 'toolUse' && !calls.length)) {
      await record({ type: 'invalid_response', response });
      return finish('error', 'Malformed tool-call IDs or empty tool-use response. Nothing executed.');
    }
    await append(response); // Preserve thinking blocks, signatures, IDs and usage.
    if (!calls.length) return finish('complete', 'Done.');

    for (const call of calls) {
      let result: ToolOutput;
      if (signal.aborted) {
        result = { text: 'Cancelled before this tool ran. Do not assume it executed.', isError: true };
      } else {
        // An unmatched marker after a crash means outcome unknown, NOT retry.
        await record({ type: 'tool_started', callId: call.id, name: call.name });
        notify({ type: 'tool-start', call });
        try { result = await tools.execute(call, signal); }
        catch (error) { result = { text: error instanceof Error ? error.message : String(error), isError: true }; }
      }
      const message: ToolResultMessage = {
        role: 'toolResult', toolCallId: call.id, toolName: call.name,
        content: [{ type: 'text', text: result.text }], isError: result.isError, timestamp: Date.now(),
      };
      await append(message);
      notify({ type: 'tool-end', call, result });
    }
    if (signal.aborted) return finish('aborted', 'Cancelled. Inspect file changes before continuing.');
  }
  return finish('limit', 'Model-request limit reached. Ask to continue, or start a new session.');
}
