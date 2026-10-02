import { Type } from '@earendil-works/pi-ai';
import { atomicWrite, defineTool, MAX_FILE_BYTES, path, readText, strict, workspacePath } from '../shared.js';

export const edit = (root: string) =>
  defineTool(
    'edit',
    'Replace exactly one occurrence of oldText with newText in a UTF-8 file. Fails on missing or ambiguous matches. Read first.',
    Type.Object(
      {
        path,
        oldText: Type.String({ minLength: 1, maxLength: MAX_FILE_BYTES }),
        newText: Type.String({ maxLength: MAX_FILE_BYTES }),
      },
      strict,
    ),
    async ({ path, oldText, newText }, signal) => {
      const target = await workspacePath(root, path);
      const original = await readText(target);
      const start = original.indexOf(oldText);
      if (start < 0) throw new Error('oldText not found. Read the file again before editing.');
      if (original.indexOf(oldText, start + 1) >= 0)
        throw new Error('oldText is ambiguous. Include more surrounding text.');
      const updated = original.slice(0, start) + newText + original.slice(start + oldText.length);
      await atomicWrite(target, updated, signal);
      return { text: `Edited ${path}: one exact replacement.`, isError: false };
    },
  );
