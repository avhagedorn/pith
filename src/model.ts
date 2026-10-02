import { createModels, type AssistantMessage, type Context } from '@earendil-works/pi-ai';
import { openrouterProvider } from '@earendil-works/pi-ai/providers/openrouter';

export const MODEL_ID = 'z-ai/glm-5.3-flash';
export const MAX_OUTPUT_TOKENS = 8192;
export type Generate = (
  context: Context,
  signal: AbortSignal,
  onText: (text: string) => void,
) => Promise<AssistantMessage>;

export function createModel(apiKey: string, sessionId: string): Generate {
  const models = createModels();
  models.setProvider(openrouterProvider());
  const model = models.getModel('openrouter', MODEL_ID);
  if (!model) throw new Error(`Pinned pi-ai catalog does not contain ${MODEL_ID}. No fallback model is configured.`);

  return async (context, signal, onText) => {
    const stream = models.streamSimple(model, context, {
      apiKey,
      sessionId,
      signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
      maxTokens: MAX_OUTPUT_TOKENS,
      reasoning: 'low',
      maxRetries: 0,
      // A fixed model, not openrouter/auto or a fallback model list.
      // Disable OpenRouter's context compression; our transcript stays explicit.
      onPayload: (payload) => ({ ...(payload as Record<string, unknown>), transforms: [] }),
    });
    for await (const event of stream) {
      if (event.type === 'text_delta') onText(event.delta);
    }
    return stream.result();
  };
}
