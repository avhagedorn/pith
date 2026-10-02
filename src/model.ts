import { createModels, type AssistantMessage, type Context } from '@earendil-works/pi-ai';
import { openrouterProvider } from '@earendil-works/pi-ai/providers/openrouter';

const PROVIDER = 'openrouter';
export const REASONING = 'low';
export const MAX_OUTPUT_TOKENS = 8192;
const REQUEST_TIMEOUT_MS = 120_000;

export type Generate = (
  context: Context,
  signal: AbortSignal,
  onText: (text: string) => void,
) => Promise<AssistantMessage>;

// One model, named in the config. No fallback, no retries, no provider-side context rewriting.
export function createModel(apiKey: string, modelId: string, sessionId: string): Generate {
  const models = createModels();
  models.setProvider(openrouterProvider());
  const model = models.getModel(PROVIDER, modelId);
  if (!model) {
    throw new Error(`Unknown OpenRouter model "${modelId}". Check "model" in the config.`);
  }

  return async (context, signal, onText) => {
    const stream = models.streamSimple(model, context, {
      apiKey,
      sessionId,
      signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
      maxTokens: MAX_OUTPUT_TOKENS,
      reasoning: REASONING,
      maxRetries: 0,
      // Empty transforms turns off OpenRouter's context compression.
      onPayload: payload => ({ ...(payload as Record<string, unknown>), transforms: [] }),
    });
    for await (const event of stream) {
      if (event.type === 'text_delta') onText(event.delta);
    }
    return stream.result();
  };
}
