import { Type } from '@earendil-works/pi-ai';
import { atomicWrite, defineTool, MAX_FILE_BYTES, path, strict, workspacePath } from '../shared.js';

export const write = (root: string) =>
  defineTool(
    'write',
    'Create or replace a UTF-8 file inside the workspace. Prefer edit for existing files. Writes are capped at 2 MiB.',
    Type.Object({ path, content: Type.String({ maxLength: MAX_FILE_BYTES }) }, strict),
    async ({ path, content }, signal) => {
      await atomicWrite(await workspacePath(root, path), content, signal);
      return { text: `Wrote ${Buffer.byteLength(content)} bytes to ${path}.`, isError: false };
    },
  );
