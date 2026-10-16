/**
 * Parent-side plumbing for the demo's key-holding child processes. The
 * Supervisor / model process forks them and talks to them only through
 * structured-clone IPC messages; it never reads a key file itself.
 */
import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function forkChild(
  relative: string,
  args: readonly string[] = [],
): ChildProcess {
  return fork(fileURLToPath(new URL(relative, import.meta.url)), [...args], {
    execArgv: ['--import', 'tsx'],
    // Structured clone: bigints and nested objects cross the boundary intact.
    serialization: 'advanced',
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
}

/** Waits for the first message matching `pick`, failing if the child exits first. */
export function nextMessage<T>(
  child: ChildProcess,
  pick: (m: unknown) => T | undefined,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const onMessage = (m: unknown) => {
      const hit = pick(m);
      if (hit === undefined) return;
      cleanup();
      resolve(hit);
    };
    const onExit = (code: number | null) => {
      cleanup();
      reject(new Error(`child exited (${code}) before answering`));
    };
    const cleanup = () => {
      child.off('message', onMessage);
      child.off('exit', onExit);
    };
    child.on('message', onMessage);
    child.on('exit', onExit);
  });
}

export async function stopChild(child: ChildProcess) {
  if (child.exitCode !== null || !child.connected) return;
  const exited = new Promise((r) => child.once('exit', r));
  child.disconnect();
  await exited;
}
