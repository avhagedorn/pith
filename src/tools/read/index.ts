import { Type } from '@earendil-works/pi-ai';
import { bounded, defineTool, path, readText, strict, workspacePath } from '../shared.js';

export const read = (root: string) =>
  defineTool(
    'read',
    'Read a UTF-8 text file inside the workspace (max 2 MiB). Returns numbered lines, capped at 32 KiB. Offsets are 1-based.',
    Type.Object(
      {
        path,
        offset: Type.Optional(Type.Integer({ minimum: 1 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000 })),
      },
      strict,
    ),
    async ({ path, offset = 1, limit = 200 }, signal) => {
      signal.throwIfAborted();
      const text = await readText(await workspacePath(root, path));
      const lines = text.split('\n');
      const end = Math.min(lines.length, offset - 1 + limit);
      const selected = lines
        .slice(offset - 1, end)
        .map((line, i) => `${offset + i}: ${line}`)
        .join('\n');
      return {
        text: bounded(selected + (end < lines.length ? `\n[more lines: next offset ${end + 1}]` : '')),
        isError: false,
      };
    },
  );
