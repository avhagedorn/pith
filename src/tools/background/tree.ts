import { spawnSync } from 'node:child_process';

// A pty puts the command in a session of its own, so the job's shell is no longer in the child's
// process group and kill(-pid) cannot reach it. Walking the real tree catches what it misses.
export function processTree(): Map<number, number[]> {
  const tree = new Map<number, number[]>();
  const result = spawnSync('ps', ['-Ao', 'pid=,ppid='], { encoding: 'utf8' });
  if (result.status !== 0 || !result.stdout) return tree;
  for (const line of result.stdout.split('\n')) {
    const [pid, parent] = line.trim().split(/\s+/).map(Number);
    if (!pid || !parent) continue;
    const siblings = tree.get(parent);
    if (siblings) siblings.push(pid);
    else tree.set(parent, [pid]);
  }
  return tree;
}

// Everything below `pid`, parents first, so reversing gives children before parents.
export function subtree(tree: Map<number, number[]>, pid: number): number[] {
  const found: number[] = [];
  const queue = [pid];
  for (let current = queue.shift(); current !== undefined; current = queue.shift()) {
    for (const child of tree.get(current) ?? []) {
      found.push(child);
      queue.push(child);
    }
  }
  return found;
}
