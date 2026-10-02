import { Type } from '@earendil-works/pi-ai';
import { defineTool, MAX_FILE_BYTES, strict, untrusted, webSignal } from '../shared.js';

const PAGE_CHARACTERS = 20_000;
const MAX_URL_LENGTH = 2048;
const USER_AGENT = 'Mozilla/5.0 (compatible; pith)';
const READABLE_TYPES = /^(text\/|application\/(json|xml|xhtml\+xml))/;
const DESCRIPTION =
  'Read a web page as plain text. Long pages come in parts: pass the offset from the ' +
  'previous result to read on. Pages that need JavaScript to render come back mostly empty.';

const MAIN_CONTENT = /<(main|article)\b[\s\S]*<\/\1>/i;
const UNSEEN_BLOCKS = /<(script|style|noscript|svg|template|head)\b[\s\S]*?<\/\1>/gi;
// Menus, sidebars, footers and controls: on the page, but not what anyone came to read.
const FURNITURE = /<(nav|aside|footer|form|button|select|dialog)\b[\s\S]*?<\/\1>/gi;
const COMMENTS = /<!--[\s\S]*?-->/g;
const BLOCK_BREAKS =
  /<\/?(p|div|section|article|li|ul|ol|tr|table|h[1-6]|br|pre|blockquote)\b[^>]*>/gi;
const TAGS = /<[^>]+>/g;
const NUMERIC_ENTITY = /&#(x[0-9a-f]+|\d+);/gi;
const NAMED_ENTITY = /&(amp|lt|gt|quot|apos|nbsp);/g;
const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

// Good enough for documentation and articles: keep the text, drop the page furniture.
export function htmlToText(html: string): string {
  const seen = html.replace(UNSEEN_BLOCKS, '').replace(COMMENTS, '');
  // A <main> or <article> element, when there is one, leaves out menus and footers.
  const content = MAIN_CONTENT.exec(seen)?.[0] ?? seen;
  return content
    .replace(FURNITURE, '')
    .replace(BLOCK_BREAKS, '\n')
    .replace(TAGS, '')
    .replace(NUMERIC_ENTITY, (_, code: string) =>
      String.fromCodePoint(Number(code[0]?.toLowerCase() === 'x' ? `0${code}` : code)),
    )
    .replace(NAMED_ENTITY, (_, name: string) => ENTITIES[name]!)
    .replace(/[ \t\r\f]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Stops reading once the cap is passed, so a huge download is never held in full.
async function readBody(response: Response): Promise<string> {
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    chunks.push(chunk);
    bytes += chunk.length;
    if (bytes > MAX_FILE_BYTES) break;
  }
  return Buffer.concat(chunks).toString('utf8');
}

export const fetchPage = () =>
  defineTool(
    'fetch',
    DESCRIPTION,
    Type.Object(
      {
        url: Type.String({ pattern: '^https?://', maxLength: MAX_URL_LENGTH }),
        offset: Type.Optional(Type.Integer({ minimum: 0 })),
      },
      strict,
    ),
    async ({ url, offset = 0 }, signal) => {
      const response = await fetch(url, {
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'text/html, text/*;q=0.9, application/json;q=0.8',
        },
        signal: webSignal(signal),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`);
      const type = response.headers.get('content-type') ?? '';
      if (!READABLE_TYPES.test(type)) throw new Error(`Not a text page (${type || 'no type'}).`);

      const body = await readBody(response);
      const text = type.includes('html') ? htmlToText(body) : body;
      const end = offset + PAGE_CHARACTERS;
      const more = end < text.length ? `\n[more of this page: next offset ${end}]` : '';
      return { text: untrusted(url, text.slice(offset, end), more), isError: false };
    },
  );
