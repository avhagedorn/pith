import {
  createModels,
  type AssistantMessage,
  type Context,
  type ToolCall,
} from '@earendil-works/pi-ai';
import { openrouterProvider } from '@earendil-works/pi-ai/providers/openrouter';
import type { Config } from './config.js';

const PROVIDER = 'openrouter';
const REQUEST_TIMEOUT_MS = 120_000;
// OpenRouter refuses a request unless your credit could cover the most it might produce,
// so asking for the model's full maximum (~1M tokens) fails on a modest balance.
const MAX_OUTPUT_TOKENS = 32_768;
// pi-ai retries only before the answer starts streaming (timeouts, 429s, 5xx), never midway.
const MAX_RETRIES = 2;

// What the model is producing right now. `size` is how many characters just arrived.
export type StreamEvent =
  | { type: 'text'; text: string }
  | { type: 'thinking'; size: number }
  | { type: 'tool-call'; size: number; tool?: string };

export type Generate = (
  context: Context,
  signal: AbortSignal,
  onStream: (event: StreamEvent) => void,
) => Promise<AssistantMessage>;

export type Model = Generate & { contextWindow: number };

// One model, set in the config. No fallback, no provider-side context rewriting.
export function createModel(config: Config, sessionId: string): Model {
  const models = createModels();
  models.setProvider(openrouterProvider());
  const model = models.getModel(PROVIDER, config.model);
  if (!model) {
    throw new Error(`Unknown OpenRouter model "${config.model}". Check "model" in the config.`);
  }

  const generate: Generate = async (context, signal, onStream) => {
    const stream = models.streamSimple(model, context, {
      apiKey: config.openrouterApiKey,
      sessionId,
      signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
      reasoning: config.reasoning,
      maxTokens: MAX_OUTPUT_TOKENS,
      maxRetries: MAX_RETRIES,
      // Empty transforms turns off OpenRouter's context compression.
      onPayload: payload => ({ ...(payload as Record<string, unknown>), transforms: [] }),
    });
    for await (const event of stream) {
      if (event.type === 'text_delta') onStream({ type: 'text', text: event.delta });
      if (event.type === 'thinking_start' || event.type === 'thinking_delta') {
        onStream({ type: 'thinking', size: 'delta' in event ? event.delta.length : 0 });
      }
      if (event.type === 'toolcall_start' || event.type === 'toolcall_delta') {
        const block = event.partial.content[event.contentIndex] as ToolCall | undefined;
        const size = 'delta' in event ? event.delta.length : 0;
        onStream({ type: 'tool-call', size, tool: block?.name || undefined });
      }
    }
    return stream.result();
  };
  return Object.assign(generate, { contextWindow: model.contextWindow });
}
