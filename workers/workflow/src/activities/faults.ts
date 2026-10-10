import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  writeFileSync,
  fsyncSync,
} from 'node:fs';
import { join } from 'node:path';

export const CRASH_POINTS = [
  'approval-wait',
  'before-activity',
  'during-activity',
  'after-submit-before-response',
  'after-confirm-before-db',
  'before-reconciliation',
  'after-reconciliation-before-completion',
] as const;
export type CrashPoint = (typeof CRASH_POINTS)[number];

/** Instrumented points in the economic Activities; a no-op unless a crash harness arms one. */
export interface FaultHooks {
  reach(point: CrashPoint, detail?: string): Promise<void>;
}
export const NO_FAULTS: FaultHooks = { reach: async () => undefined };

/**
 * Test-only: when the armed point is reached the hook writes a marker and parks forever, so the
 * harness can SIGKILL this worker process while it sits exactly at that point. The marker is created
 * exclusively, so a restarted worker passes through.
 */
export function parkingFaults(
  directory: string,
  armed: CrashPoint | null,
): FaultHooks {
  mkdirSync(directory, { recursive: true });
  return {
    async reach(point, detail) {
      if (point !== armed) return;
      const marker = join(directory, `reached-${point}`);
      if (existsSync(marker)) return;
      const fd = openSync(marker, 'wx', 0o600);
      try {
        writeFileSync(fd, `${process.pid} ${detail ?? ''}\n`);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      await new Promise<never>(() => undefined);
    },
  };
}
