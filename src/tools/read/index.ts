import { Type } from '@earendil-works/pi-ai';
import { bounded, defineTool, path, readText, strict, workspacePath } from '../shared.js';

const DEFAULT_LINES = 200;
const MAX_LINES = 2000;
const DESCRIPTION =
  'Read a UTF-8 text file inside the workspace (max 2 MiB). ' +
  'Returns numbered lines, capped at 32 KiB. Offsets are 1-based.';

export const read = (root: string) =>
  defineTool(
    'read',
    DESCRIPTION,
    Type.Object(
      {
        path,
        offset: Type.Optional(Type.Integer({ minimum: 1 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_LINES })),
      },
      strict,
    ),
    async ({ path, offset = 1, limit = DEFAULT_LINES }, signal) => {
      signal.throwIfAborted();
      const lines = (await readText(await workspacePath(root, path))).split('\n');
      const end = Math.min(lines.length, offset - 1 + limit);
      const numbered = lines.slice(offset - 1, end).map((line, i) => `${offset + i}: ${line}`);
      if (end < lines.length) numbered.push(`[more lines: next offset ${end + 1}]`);
      return { text: bounded(numbered.join('\n')), isError: false };
    },
  );
