import type { AssistantMessage, Context, Message, ToolCall, Usage } from '@earendil-works/pi-ai';
import { errorText } from './errors.js';
import type { Generate } from './model.js';
import type { RecordEvent } from './session.js';
import type { ToolOutput, ToolSet } from './tools/index.js';

export const MAX_CONTEXT_BYTES = 512 * 1024;
const FINISHED_STOP_REASONS = new Set<string>(['stop', 'toolUse']);
const NOT_RUN: ToolOutput = {
  text: 'Cancelled before this tool ran. Do not assume it executed.',
  isError: true,
};

// Progress events for whoever draws the UI. The loop never prints.
export type Notice =
  | { type: 'request'; step: number }
  | { type: 'text'; text: string }
  | { type: 'tool-start'; call: ToolCall }
  | { type: 'tool-end'; call: ToolCall; result: ToolOutput }
  | { type: 'usage'; usage: Usage };

export interface RunOutcome {
  reason: 'complete' | 'aborted' | 'limit' | 'error';
  detail: string;
}

export interface TurnOptions {
  prompt: string;
  context: Context;
  generate: Generate;
  tools: ToolSet;
  record: RecordEvent;
  onProgress: (notice: Notice) => void;
  signal: AbortSignal;
  maxSteps: number;
  maxContextBytes?: number;
}

/**
 * Runs one user turn: ask the model, run the tools it asks for, repeat until it answers in text.
 *
 * Two rules shape the code below:
 * - Only a complete, well-formed response may enter the conversation or run tools.
 * - Every tool call that enters the conversation gets a result, even when the turn is cancelled.
 */
export async function runTurn(options: TurnOptions): Promise<RunOutcome> {
  const { prompt, context, generate, tools, record, onProgress, signal, maxSteps } = options;
  const maxContextBytes = options.maxContextBytes ?? MAX_CONTEXT_BYTES;

  // Logged first, so the log never trails the conversation.
  const append = async (message: Message) => {
    await record({ type: 'message', message });
    context.messages.push(message);
  };

  const finish = async (reason: RunOutcome['reason'], detail: string): Promise<RunOutcome> => {
    await record({ type: 'run_end', reason, detail });
    return { reason, detail };
  };

  const runTool = async (call: ToolCall): Promise<ToolOutput> => {
    if (signal.aborted) return NOT_RUN;

    // Marker first: after a crash, a marker with no result means "unknown", not "retry".
    await record({ type: 'tool_started', callId: call.id, name: call.name });
    onProgress({ type: 'tool-start', call });
    try {
      return await tools.execute(call, signal);
    } catch (error) {
      return { text: errorText(error), isError: true };
    }
  };

  if (signal.aborted) return finish('aborted', 'Cancelled before starting.');
  await append({ role: 'user', content: prompt, timestamp: Date.now() });

  for (let step = 1; step <= maxSteps; step++) {
    if (signal.aborted) return finish('aborted', 'Cancelled.');
    if (Buffer.byteLength(JSON.stringify(context)) > maxContextBytes) {
      return finish(
        'limit',
        'Transcript reached the 512 KiB input cap. Start a new session; v0 does not compact.',
      );
    }

    onProgress({ type: 'request', step });
    let response: AssistantMessage;
    try {
      response = await generate(context, signal, text => onProgress({ type: 'text', text }));
    } catch (error) {
      return finish(signal.aborted ? 'aborted' : 'error', errorText(error));
    }
    onProgress({ type: 'usage', usage: response.usage });

    // A cut-off response may hold half-written tool calls. Logged, never replayed.
    if (signal.aborted || !FINISHED_STOP_REASONS.has(response.stopReason)) {
      await record({ type: 'incomplete_response', response });
      const detail = `Model stopped with ${response.stopReason}; none of its tools were run.`;
      return finish(signal.aborted ? 'aborted' : 'error', response.errorMessage || detail);
    }

    // Results pair with calls by ID, so IDs must be present and distinct.
    const calls = response.content.filter((block): block is ToolCall => block.type === 'toolCall');
    const ids = new Set(calls.map(call => call.id));
    const idsUsable = calls.every(call => call.id) && ids.size === calls.length;
    const promisedToolsButSentNone = response.stopReason === 'toolUse' && !calls.length;
    if (!idsUsable || promisedToolsButSentNone) {
      await record({ type: 'invalid_response', response });
      return finish(
        'error',
        'Malformed tool-call IDs or empty tool-use response. Nothing executed.',
      );
    }

    // Kept whole: thinking blocks and signatures must go back unchanged.
    await append(response);
    if (!calls.length) return finish('complete', 'Done.');

    // One at a time, in order. After a cancel the rest are answered but not run.
    for (const call of calls) {
      const result = await runTool(call);
      await append({
        role: 'toolResult',
        toolCallId: call.id,
        toolName: call.name,
        content: [{ type: 'text', text: result.text }],
        isError: result.isError,
        timestamp: Date.now(),
      });
      onProgress({ type: 'tool-end', call, result });
    }
    if (signal.aborted)
      return finish('aborted', 'Cancelled. Inspect file changes before continuing.');
  }

  return finish('limit', 'Model-request limit reached. Ask to continue, or start a new session.');
}
