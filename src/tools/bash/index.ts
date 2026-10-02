import { Type } from '@earendil-works/pi-ai';
import { defineTool, strict } from '../shared.js';
import { DEFAULT_TIMEOUT_S, MAX_TIMEOUT_S, runShell } from './shell.js';

const MAX_COMMAND_LENGTH = 32_768;
const DESCRIPTION =
  'Run a non-interactive bash command in the workspace. UNSANDBOXED. No background jobs. ' +
  'stdout/stderr combined, capped at 32 KiB. ' +
  `Default timeout ${DEFAULT_TIMEOUT_S}s; maximum ${MAX_TIMEOUT_S}s.`;

export const bash = (root: string) =>
  defineTool(
    'bash',
    DESCRIPTION,
    Type.Object(
      {
        command: Type.String({ minLength: 1, maxLength: MAX_COMMAND_LENGTH }),
        timeout: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_TIMEOUT_S })),
      },
      strict,
    ),
    ({ command, timeout = DEFAULT_TIMEOUT_S }, signal) =>
      runShell(command, root, signal, timeout * 1000),
  );
