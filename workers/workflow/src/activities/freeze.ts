import { existsSync, readFileSync } from 'node:fs';
import { writeDurableJson } from '@synq/execution-worker/persistence';
import type { AutonomyFreezePort } from './economic.js';

type FreezeRecord = {
  groupId: string;
  reason: string;
  incidentId: string;
  since: number;
};

/** Durable Synq-side autonomy freeze, read by every economic Activity before it moves value. */
export class FileAutonomyFreeze implements AutonomyFreezePort {
  constructor(
    private readonly path: string,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {}
  private read(): FreezeRecord[] {
    return existsSync(this.path)
      ? (JSON.parse(readFileSync(this.path, 'utf8')) as FreezeRecord[])
      : [];
  }
  async status(groupId: string) {
    const record = this.read().find((r) => r.groupId === groupId);
    return record
      ? { frozen: true, reason: record.reason, since: record.since }
      : { frozen: false, reason: null, since: null };
  }
  async freeze(groupId: string, reason: string, incidentId: string) {
    const all = this.read();
    const existing = all.find((r) => r.groupId === groupId);
    if (existing) return { since: existing.since };
    const since = this.now();
    writeDurableJson(this.path, [
      ...all,
      { groupId, reason, incidentId, since },
    ]);
    return { since };
  }
  async unfreeze(groupId: string, incidentId: string) {
    const all = this.read();
    const kept = all.filter(
      (r) => !(r.groupId === groupId && r.incidentId === incidentId),
    );
    if (kept.length !== all.length) writeDurableJson(this.path, kept);
  }
}
