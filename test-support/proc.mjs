// Cross-platform process control for the harnesses that spawn servers or stop
// MySQL (verify-audit.mjs, verify-fail-closed.mjs). The same harness runs on a
// developer's Windows machine and in Ubuntu CI, so nothing here may assume one
// OS's tools.
import { execSync, spawnSync } from 'node:child_process';

export const WIN = process.platform === 'win32';

/** PID listening on a TCP port, or null. */
export function listenerPid(port) {
  try {
    if (WIN) {
      const out = execSync('netstat -ano', { encoding: 'utf8' });
      const line = out.split(/\r?\n/).find((l) => new RegExp(`[:.]${port}\\s`).test(l) && /LISTENING/.test(l));
      return line ? Number(line.trim().split(/\s+/).pop()) : null;
    }
    const out = execSync(`lsof -ti tcp:${port} -sTCP:LISTEN`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const first = out.trim().split('\n')[0];
    return first ? Number(first) : null;
  } catch {
    return null; // lsof exits non-zero when nothing listens
  }
}

/** Whether a process is still running. */
export function processAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/**
 * Kill a process and its children. On POSIX the servers are spawned detached
 * (their own process group), so the group is killed; on Windows taskkill /T
 * walks the tree.
 */
export function killTree(pid) {
  if (!pid) return;
  if (WIN) {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F']);
    return;
  }
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

/** spawn() options that make killTree() able to take the whole tree down. */
export const TREE_OPTS = WIN ? {} : { detached: true };
