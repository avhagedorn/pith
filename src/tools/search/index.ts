import { setTimeout as sleep } from 'node:timers/promises';
import { Type } from '@earendil-works/pi-ai';
import { defineTool, strict } from '../shared.js';
import { untrusted, webSignal } from '../web.js';

// Exa's hosted search endpoint. It answers anonymous requests within a rate limit; a key lifts it.
const ENDPOINT = 'https://mcp.exa.ai/mcp';
const REMOTE_TOOL = 'web_search_exa';
const API_KEY_HEADER = 'x-api-key';
const DEFAULT_RESULTS = 5;
const MAX_RESULTS = 10;
const MAX_QUERY_LENGTH = 400;
const EVENT_DATA = 'data: ';
const DESCRIPTION =
  'Search the web. Returns titles, URLs and relevant excerpts. ' +
  'Use fetch to read a result in full.';

const RATE_LIMITED_FLAG = 'ai.exa/rateLimited';
// The anonymous limit is counted over a short window, so a brief wait usually clears it.
const RETRY_DELAYS_MS = [2000, 6000];

interface Reply {
  result?: { content?: { text?: string }[]; isError?: boolean; _meta?: Record<string, unknown> };
  error?: { message?: string };
}

class RateLimited extends Error {
  constructor() {
    super('Search is rate limited right now. Do not retry yet; fetch a known URL instead.');
  }
}

// The endpoint replies as a server-sent event stream; the JSON-RPC reply is its data line.
// A rate-limited reply looks like a normal result, so its flag is checked first.
export function parseSearchReply(body: string): string {
  const line = body.split('\n').find(line => line.startsWith(EVENT_DATA));
  const reply: Reply = JSON.parse(line ? line.slice(EVENT_DATA.length) : body);
  if (reply.result?._meta?.[RATE_LIMITED_FLAG]) throw new RateLimited();
  const text = reply.result?.content?.map(part => part.text ?? '').join('\n');
  if (reply.error || reply.result?.isError || !text) {
    throw new Error(`Search failed: ${reply.error?.message ?? (text || 'empty reply')}`);
  }
  return text;
}

interface SearchOptions {
  endpoint?: string;
  retryDelays?: number[];
  apiKey?: string; // lifts the anonymous rate limit
}

export const search = ({
  endpoint = ENDPOINT,
  retryDelays = RETRY_DELAYS_MS,
  apiKey,
}: SearchOptions = {}) =>
  defineTool(
    'search',
    DESCRIPTION,
    Type.Object(
      {
        query: Type.String({ minLength: 1, maxLength: MAX_QUERY_LENGTH }),
        results: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_RESULTS })),
      },
      strict,
    ),
    async ({ query, results = DEFAULT_RESULTS }, signal) => {
      const request = async () => {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            ...(apiKey && { [API_KEY_HEADER]: apiKey }),
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: REMOTE_TOOL, arguments: { query, numResults: results } },
          }),
          signal: webSignal(signal),
        });
        if (!response.ok) throw new Error(`Search failed: HTTP ${response.status}`);
        return parseSearchReply(await response.text());
      };

      for (const delay of retryDelays) {
        try {
          return { text: untrusted('web search', await request()), isError: false };
        } catch (error) {
          if (!(error instanceof RateLimited)) throw error;
          await sleep(delay, undefined, { signal });
        }
      }
      return { text: untrusted('web search', await request()), isError: false };
    },
  );
