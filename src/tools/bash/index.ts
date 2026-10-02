import { Type } from '@earendil-works/pi-ai';
import { defineTool, strict } from '../shared.js';
import { runShell } from './shell.js';

export const bash = (root: string) =>
  defineTool(
    'bash',
    'Run a non-interactive bash command in the workspace. UNSANDBOXED. No background jobs. stdout/stderr combined, capped at 32 KiB. Default timeout 30s; maximum 120s.',
    Type.Object(
      {
        command: Type.String({ minLength: 1, maxLength: 32_768 }),
        timeout: Type.Optional(Type.Integer({ minimum: 1, maximum: 120 })),
      },
      strict,
    ),
    ({ command, timeout = 30 }, signal) => runShell(command, root, signal, timeout * 1000),
  );
