import { createModels, type AssistantMessage, type Context } from '@earendil-works/pi-ai';
import { openrouterProvider } from '@earendil-works/pi-ai/providers/openrouter';
import type { Config } from './config.js';

const PROVIDER = 'openrouter';
const REQUEST_TIMEOUT_MS = 120_000;
// OpenRouter refuses a request unless your credit could cover the most it might produce,
// so asking for the model's full maximum (~1M tokens) fails on a modest balance.
const MAX_OUTPUT_TOKENS = 32_768;
// pi-ai retries only before the answer starts streaming (timeouts, 429s, 5xx), never midway.
const MAX_RETRIES = 2;

export type Generate = (
  context: Context,
  signal: AbortSignal,
  onText: (text: string) => void,
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

  const generate: Generate = async (context, signal, onText) => {
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
      if (event.type === 'text_delta') onText(event.delta);
    }
    return stream.result();
  };
  return Object.assign(generate, { contextWindow: model.contextWindow });
}
