import { createConnection } from 'node:net';

// herdr (herdr.dev) is a terminal workspace manager for coding agents. Inside one of its panes
// it sets these variables, and pith reports whether it is working or waiting on you.
const SOURCE = 'herdr:pith';
const AGENT = 'pith';
const TIMEOUT_MS = 1000;

export type AgentState = 'working' | 'idle';

// Returns a reporter that never throws and never makes pith wait. Outside herdr it does nothing.
export function herdrReporter(env: NodeJS.ProcessEnv = process.env) {
  const { HERDR_ENV, HERDR_SOCKET_PATH: socketPath, HERDR_PANE_ID: paneId } = env;
  const enabled = HERDR_ENV === '1' && Boolean(socketPath) && Boolean(paneId);
  let seq = Date.now() * 1000; // herdr ignores reports older than one it has already seen
  let queue = Promise.resolve(); // reports are sent one at a time, in order

  const send = (method: string, params: Record<string, unknown>) => {
    if (!enabled) return queue;
    const request = {
      id: `${SOURCE}:${++seq}`,
      method,
      params: { pane_id: paneId, source: SOURCE, agent: AGENT, seq, ...params },
    };
    queue = queue.then(
      () =>
        new Promise<void>(resolve => {
          const socket = createConnection(socketPath!);
          const done = () => {
            socket.destroy();
            resolve();
          };
          socket.setTimeout(TIMEOUT_MS, done);
          socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`));
          socket.on('data', done).on('error', done).on('end', done);
        }),
    );
    return queue;
  };

  return {
    session: (logPath: string) =>
      send('pane.report_agent_session', { agent_session_path: logPath }),
    state: (state: AgentState) => send('pane.report_agent', { state }),
  };
}
