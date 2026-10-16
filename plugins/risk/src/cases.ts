import { createHash } from 'node:crypto';
import type { Address } from 'viem';
import type { Citation } from './citations.js';
import {
  anchorAudit,
  nextAuditRecord,
  verifyAnchoredChain,
  type AnchoredCheck,
  type AuditAnchor,
  type AuditRecord,
} from './audit.js';
import { recoverCaseResolver, type CaseResolution } from './policy.js';
import { NON_OVERRIDABLE_CODES, type RiskFlag } from './rules.js';

/**
 * Case management for risk alerts: explainable holds, human review, owner
 * resolution and appeal. Invariants:
 *
 *  - an alert is processed once, atomically with its case: a replayed alert
 *    (same `alertKey`) attaches nothing and freezes nothing, and a claimed
 *    alert never exists without its case;
 *  - one subject (a requested payout destination) has at most one active
 *    case, so it is frozen at most once;
 *  - review cannot bypass hard wallet policy: a reviewer's RELEASE is checked
 *    against the *current* facts (re-evaluated, not the flags stored when the
 *    case opened); a hard fact that still holds is refused;
 *  - cases resolve when facts change (`reevaluate`), or by an owner-signed
 *    EIP-712 resolution; neither lifts wallet policy, which the rules, the
 *    Kernel mandate and the vault re-derive on every payout decision.
 */
export const CASE_STATUSES = [
  'HELD',
  'IN_REVIEW',
  'APPEALED',
  'RELEASED',
  'RESOLVED',
  'BLOCKED',
] as const;
export type CaseStatus = (typeof CASE_STATUSES)[number];
export const ACTIVE_CASE_STATUSES: readonly CaseStatus[] = [
  'HELD',
  'IN_REVIEW',
  'APPEALED',
  'BLOCKED',
];

export type RiskAlert = Readonly<{
  workspaceId: string;
  /** Deterministic: same rule + subject + evidence = same key. */
  alertKey: string;
  /** The requested payout destination the alert is about. */
  subjectRef: string;
  counterparty: string;
  flags: readonly RiskFlag[];
  raisedBy: string;
  at: number;
  citations?: readonly Citation[];
}>;

export type CaseEvent = Readonly<{
  at: number;
  actor: string;
  action:
    | 'OPENED'
    | 'FROZEN'
    | 'ALERT_ATTACHED'
    | 'REVIEW_STARTED'
    | 'RELEASED'
    | 'RELEASE_REFUSED'
    | 'RESOLVED_FACTS_CHANGED'
    | 'RESOLVED_BY_OWNER'
    | 'BLOCKED'
    | 'APPEALED';
  note: string;
}>;

export type RiskCase = Readonly<{
  caseId: string;
  workspaceId: string;
  subjectRef: string;
  counterparty: string;
  status: CaseStatus;
  flags: readonly RiskFlag[];
  alertKeys: readonly string[];
  /** Times the subject was frozen by this case (1 for any case). */
  freezes: number;
  events: readonly CaseEvent[];
  rev: number;
  openedAt: number;
}>;

export type Reviewer = Readonly<{
  principalId: string;
  /** Only humans review; agent identities are refused. */
  kind: 'HUMAN' | 'AGENT';
  role: 'OWNER' | 'APPROVER' | 'ACCOUNTANT' | 'MEMBER';
  /** How the reviewer proved who they are (e.g. EIP-712 signature id). */
  proof: string;
}>;

export class CaseError extends Error {
  constructor(
    readonly code:
      | 'NOT_FOUND'
      | 'NOT_A_HUMAN'
      | 'NOT_AUTHORIZED'
      | 'BAD_STATE'
      | 'CONFLICT'
      | 'BAD_SIGNATURE',
    message: string,
  ) {
    super(message);
    this.name = 'CaseError';
  }
}

/**
 * Storage for cases, alerts, the audit chain and its anchors.
 * `transaction` runs `fn` atomically (all writes or none); implementations
 * must make `claimAlert` unique, allow at most one active case per subject,
 * and reject a `saveCase` whose `rev` is stale.
 */
export interface RiskCaseStore {
  transaction<T>(fn: (tx: RiskCaseStore) => Promise<T>): Promise<T>;
  claimAlert(alert: RiskAlert): Promise<boolean>;
  activeCase(workspaceId: string, subjectRef: string): Promise<RiskCase | null>;
  getCase(caseId: string): Promise<RiskCase | null>;
  /** Inserts a new case; false when another active case for the subject exists. */
  insertCase(c: RiskCase): Promise<boolean>;
  /** Optimistic update: false when `expectedRev` is no longer current. */
  saveCase(c: RiskCase, expectedRev: number): Promise<boolean>;
  auditHead(workspaceId: string): Promise<AuditRecord | null>;
  /** Appends exactly `r`; false when `r.seq` is already taken. */
  appendAudit(r: AuditRecord): Promise<boolean>;
  audit(workspaceId: string): Promise<AuditRecord[]>;
  saveAnchor(a: AuditAnchor): Promise<void>;
  latestAnchor(workspaceId: string): Promise<AuditAnchor | null>;
}

export class MemoryRiskCaseStore implements RiskCaseStore {
  private alerts = new Set<string>();
  private cases = new Map<string, RiskCase>();
  private readonly trail = new Map<string, AuditRecord[]>();
  private readonly anchors = new Map<string, AuditAnchor>();
  private queue: Promise<unknown> = Promise.resolve();
  /** Serialised; alerts and cases roll back if `fn` throws. */
  async transaction<T>(fn: (tx: RiskCaseStore) => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const alerts = new Set(this.alerts);
      const cases = new Map(this.cases);
      try {
        return await fn(this);
      } catch (e) {
        this.alerts = alerts;
        this.cases = cases;
        throw e;
      }
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
  async claimAlert(a: RiskAlert) {
    const k = `${a.workspaceId}\u0000${a.alertKey}`;
    if (this.alerts.has(k)) return false;
    this.alerts.add(k);
    return true;
  }
  async activeCase(ws: string, subject: string) {
    return (
      [...this.cases.values()].find(
        (c) =>
          c.workspaceId === ws &&
          c.subjectRef === subject &&
          ACTIVE_CASE_STATUSES.includes(c.status),
      ) ?? null
    );
  }
  async getCase(id: string) {
    return this.cases.get(id) ?? null;
  }
  async insertCase(c: RiskCase) {
    if (await this.activeCase(c.workspaceId, c.subjectRef)) return false;
    if (this.cases.has(c.caseId)) return false;
    this.cases.set(c.caseId, c);
    return true;
  }
  async saveCase(c: RiskCase, expectedRev: number) {
    const cur = this.cases.get(c.caseId);
    if (!cur || cur.rev !== expectedRev) return false;
    if (
      ACTIVE_CASE_STATUSES.includes(c.status) &&
      [...this.cases.values()].some(
        (x) =>
          x.caseId !== c.caseId &&
          x.workspaceId === c.workspaceId &&
          x.subjectRef === c.subjectRef &&
          ACTIVE_CASE_STATUSES.includes(x.status),
      )
    )
      return false;
    this.cases.set(c.caseId, c);
    return true;
  }
  async auditHead(ws: string) {
    return this.trail.get(ws)?.at(-1) ?? null;
  }
  async appendAudit(r: AuditRecord) {
    const list = this.trail.get(r.workspaceId) ?? [];
    if ((list.at(-1)?.seq ?? 0) + 1 !== r.seq) return false;
    this.trail.set(r.workspaceId, [...list, r]);
    return true;
  }
  async audit(ws: string) {
    return [...(this.trail.get(ws) ?? [])];
  }
  async saveAnchor(a: AuditAnchor) {
    this.anchors.set(a.workspaceId, a);
  }
  async latestAnchor(ws: string) {
    return this.anchors.get(ws) ?? null;
  }
  /** Test hook: overwrite a stored record (simulates tampering at rest). */
  tamper(ws: string, seq: number, edit: (r: AuditRecord) => AuditRecord) {
    const list = this.trail.get(ws) ?? [];
    this.trail.set(
      ws,
      list.map((r) => (r.seq === seq ? edit(r) : r)),
    );
  }
  /** Test hook: drop the newest records (simulates tail truncation). */
  truncate(ws: string, keep: number) {
    this.trail.set(ws, (this.trail.get(ws) ?? []).slice(0, keep));
  }
}

const caseIdOf = (ws: string, subject: string, alertKey: string) =>
  `case_${createHash('sha256').update(`${ws}:${subject}:${alertKey}`).digest('hex').slice(0, 16)}`;

/** Digest of a case's flag codes, bound into an owner resolution signature. */
export function caseFlagsDigest(c: RiskCase): string {
  return createHash('sha256')
    .update([...new Set(c.flags.map((f) => f.code))].sort().join(','))
    .digest('hex')
    .slice(0, 32);
}

export type RaiseOutcome = Readonly<{
  status: 'OPENED' | 'ATTACHED' | 'DUPLICATE_ALERT';
  case: RiskCase | null;
  /** True only when this call froze the subject. */
  froze: boolean;
}>;

class Retry extends Error {}

/** Independently retained checkpoint; must not share the audit database's rollback domain. */
export interface AuditCheckpointStore {
  save(anchor: AuditAnchor): Promise<void>;
  latest(workspaceId: string): Promise<AuditAnchor | null>;
}

export class RiskCaseService {
  constructor(
    readonly store: RiskCaseStore,
    private readonly now: () => number,
    /** Kernel-held key for audit head anchors (never stored with the trail). */
    private readonly anchorKey: Uint8Array | null = null,
    private readonly checkpoints?: AuditCheckpointStore,
  ) {
    if (anchorKey && anchorKey.byteLength < 32)
      throw new Error('audit anchor key must be at least 32 bytes');
  }

  /** Appends one audit record, retrying on a concurrent append. */
  async record(
    workspaceId: string,
    actor: string,
    kind: string,
    payload: unknown,
    citations: readonly Citation[] = [],
  ): Promise<AuditRecord> {
    // Optimistic append: the store accepts only the direct successor of the
    // head, so concurrent writers retry (with jitter) until each lands once.
    for (let attempt = 0; attempt < 50; attempt++) {
      if (attempt)
        await new Promise((r) =>
          setTimeout(r, Math.floor(Math.random() * 5 * Math.min(attempt, 6))),
        );
      const head = await this.store.auditHead(workspaceId);
      const r = nextAuditRecord(head, {
        workspaceId,
        at: this.now(),
        actor,
        kind,
        payload,
        citations,
      });
      if (await this.store.appendAudit(r)) return r;
    }
    throw new CaseError('CONFLICT', 'audit chain is contended');
  }

  /** Anchors the current head with the Kernel key (no-op without a key). */
  async anchor(workspaceId: string): Promise<AuditAnchor | null> {
    if (!this.anchorKey) return null;
    const head = await this.store.auditHead(workspaceId);
    if (!head) return null;
    const a = anchorAudit(this.anchorKey, head, this.now());
    await this.store.saveAnchor(a);
    await this.checkpoints?.save(a);
    return a;
  }

  async verifyTrail(workspaceId: string): Promise<AnchoredCheck> {
    return verifyAnchoredChain(
      await this.store.audit(workspaceId),
      this.checkpoints
        ? await this.checkpoints.latest(workspaceId)
        : await this.store.latestAnchor(workspaceId),
      this.anchorKey,
    );
  }

  /**
   * Raise an alert. The claim and the case write commit together: a replay
   * is a no-op, a new alert on a subject with an active case attaches
   * without a second freeze, and a failure leaves no claimed-but-caseless
   * alert behind.
   */
  async raise(alert: RiskAlert): Promise<RaiseOutcome> {
    for (let attempt = 0; attempt < 8; attempt++) {
      let out: RaiseOutcome;
      try {
        out = await this.store.transaction(async (tx) => {
          if (!(await tx.claimAlert(alert)))
            return {
              status: 'DUPLICATE_ALERT' as const,
              case: await tx.activeCase(alert.workspaceId, alert.subjectRef),
              froze: false,
            };
          const existing = await tx.activeCase(
            alert.workspaceId,
            alert.subjectRef,
          );
          if (existing) {
            const codes = new Set(existing.flags.map((f) => f.code));
            const next: RiskCase = {
              ...existing,
              flags: [
                ...existing.flags,
                ...alert.flags.filter((f) => !codes.has(f.code)),
              ],
              alertKeys: [...existing.alertKeys, alert.alertKey],
              events: [
                ...existing.events,
                {
                  at: alert.at,
                  actor: alert.raisedBy,
                  action: 'ALERT_ATTACHED',
                  note: alert.alertKey,
                },
              ],
              rev: existing.rev + 1,
            };
            if (!(await tx.saveCase(next, existing.rev))) throw new Retry();
            return { status: 'ATTACHED' as const, case: next, froze: false };
          }
          const c: RiskCase = {
            caseId: caseIdOf(
              alert.workspaceId,
              alert.subjectRef,
              alert.alertKey,
            ),
            workspaceId: alert.workspaceId,
            subjectRef: alert.subjectRef,
            counterparty: alert.counterparty,
            status: 'HELD',
            flags: [...alert.flags],
            alertKeys: [alert.alertKey],
            freezes: 1,
            events: [
              {
                at: alert.at,
                actor: alert.raisedBy,
                action: 'OPENED',
                note: alert.alertKey,
              },
              {
                at: alert.at,
                actor: alert.raisedBy,
                action: 'FROZEN',
                note: `payouts to ${alert.subjectRef} held`,
              },
            ],
            rev: 1,
            openedAt: alert.at,
          };
          if (!(await tx.insertCase(c))) throw new Retry();
          return { status: 'OPENED' as const, case: c, froze: true };
        });
      } catch (e) {
        if (e instanceof Retry) continue;
        throw e;
      }
      if (out.status === 'DUPLICATE_ALERT')
        await this.record(alert.workspaceId, alert.raisedBy, 'ALERT_REPLAYED', {
          alertKey: alert.alertKey,
          subjectRef: alert.subjectRef,
        });
      else
        await this.record(
          alert.workspaceId,
          alert.raisedBy,
          out.status === 'OPENED' ? 'CASE_OPENED' : 'ALERT_ATTACHED',
          { caseId: out.case!.caseId, alert },
          alert.citations ?? [],
        );
      return out;
    }
    throw new CaseError('CONFLICT', 'could not open or attach the case');
  }

  /**
   * Flags the Kernel must see for a subject: an active case is a HARD hold.
   * A released or resolved case adds nothing; wallet-policy flags are
   * recomputed from current facts on every decision anyway.
   */
  async holdFlags(
    workspaceId: string,
    subjectRef: string,
  ): Promise<RiskFlag[]> {
    const c = await this.store.activeCase(workspaceId, subjectRef);
    if (!c) return [];
    return [
      {
        code: 'CASE_HOLD',
        severity: 'HARD',
        detail: `${c.caseId} is ${c.status}: ${c.flags.map((f) => f.code).join(', ')}`,
      },
    ];
  }

  private assertReviewer(r: Reviewer) {
    if (r.kind !== 'HUMAN')
      throw new CaseError('NOT_A_HUMAN', 'only a human may review a case');
    if (r.role !== 'OWNER' && r.role !== 'APPROVER')
      throw new CaseError(
        'NOT_AUTHORIZED',
        `${r.role} cannot decide a risk case`,
      );
    if (!r.proof.trim())
      throw new CaseError('NOT_AUTHORIZED', 'reviewer identity is unproven');
  }

  private async update(
    caseId: string,
    f: (c: RiskCase) => RiskCase,
  ): Promise<RiskCase> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const c = await this.store.getCase(caseId);
      if (!c) throw new CaseError('NOT_FOUND', caseId);
      const next = f(c);
      if (next === c) return c;
      if (await this.store.saveCase(next, c.rev)) return next;
    }
    throw new CaseError('CONFLICT', caseId);
  }

  /**
   * Facts changed: `current` are the flags the rules produce *now* for this
   * subject. When none of them is HARD the case resolves; otherwise the
   * case's flags are replaced by the current ones (so a stale reason never
   * outlives its facts).
   */
  async reevaluate(
    caseId: string,
    current: readonly RiskFlag[],
    actor = 'RULES',
  ): Promise<RiskCase> {
    const at = this.now();
    const hard = current.filter((f) => f.severity === 'HARD');
    const out = await this.update(caseId, (c) => {
      if (!ACTIVE_CASE_STATUSES.includes(c.status)) return c;
      if (c.flags.some((f) => f.severity === 'HARD'))
        throw new CaseError(
          'NOT_AUTHORIZED',
          'hard cases require an owner-signed resolution',
        );
      if (hard.length)
        return JSON.stringify(c.flags) === JSON.stringify(hard)
          ? c
          : { ...c, flags: [...hard], rev: c.rev + 1 };
      return {
        ...c,
        status: 'RESOLVED',
        events: [
          ...c.events,
          {
            at,
            actor,
            action: 'RESOLVED_FACTS_CHANGED',
            note: 'no hard flag holds on current facts',
          },
        ],
        rev: c.rev + 1,
      };
    });
    if (out.status === 'RESOLVED')
      await this.record(out.workspaceId, actor, 'CASE_RESOLVED', {
        caseId,
        reason: 'facts changed',
      });
    return out;
  }

  /**
   * Human decision. RELEASE clears the case hold only when no hard,
   * non-overridable flag holds on the *current* facts (`current`, from the
   * rules; when omitted, the stored flags are used). BLOCK closes the
   * subject until an appeal.
   */
  async review(
    caseId: string,
    reviewer: Reviewer,
    decision: 'RELEASE' | 'BLOCK',
    note: string,
    current?: readonly RiskFlag[],
  ): Promise<{ case: RiskCase; refused: string[] }> {
    this.assertReviewer(reviewer);
    let refused: string[] = [];
    const at = this.now();
    const out = await this.update(caseId, (c) => {
      refused = [];
      if (c.status === 'RELEASED' && decision === 'RELEASE') return c;
      if (c.status === 'BLOCKED' && decision === 'BLOCK') return c;
      if (c.status === 'RESOLVED') return c;
      if (c.status === 'BLOCKED' && decision === 'RELEASE')
        throw new CaseError(
          'BAD_STATE',
          'a blocked case reopens only through an appeal',
        );
      if (decision === 'RELEASE') {
        refused = [...c.flags, ...(current ?? [])]
          .filter(
            (f) => f.severity === 'HARD' && NON_OVERRIDABLE_CODES.has(f.code),
          )
          .map((f) => f.code);
        if (refused.length)
          return {
            ...c,
            status: 'IN_REVIEW',
            events: [
              ...c.events,
              {
                at,
                actor: reviewer.principalId,
                action: 'RELEASE_REFUSED',
                note: `hard wallet policy cannot be overridden by review: ${refused.join(', ')}`,
              },
            ],
            rev: c.rev + 1,
          };
        return {
          ...c,
          status: 'RELEASED',
          events: [
            ...c.events,
            {
              at,
              actor: reviewer.principalId,
              action: 'RELEASED',
              note: note.slice(0, 300),
            },
          ],
          rev: c.rev + 1,
        };
      }
      return {
        ...c,
        status: 'BLOCKED',
        events: [
          ...c.events,
          {
            at,
            actor: reviewer.principalId,
            action: 'BLOCKED',
            note: note.slice(0, 300),
          },
        ],
        rev: c.rev + 1,
      };
    });
    await this.record(out.workspaceId, reviewer.principalId, 'CASE_REVIEWED', {
      caseId,
      decision,
      status: out.status,
      refused,
      reviewerProof: reviewer.proof,
      note,
    });
    return { case: out, refused };
  }

  /**
   * The workspace owner's EIP-712 resolution releases the case hold (even
   * over hard stored flags). It does not lift wallet policy: the rules, the
   * Kernel mandate allowlist and the vault still decide every payout.
   */
  async resolveWithOwner(
    caseId: string,
    resolution: CaseResolution,
    input: { owners: readonly Address[]; chainId: number },
  ): Promise<RiskCase> {
    const c = await this.store.getCase(caseId);
    if (!c) throw new CaseError('NOT_FOUND', caseId);
    if (
      resolution.caseId !== caseId ||
      resolution.workspaceId !== c.workspaceId ||
      resolution.flagsDigest !== caseFlagsDigest(c) ||
      this.now() > resolution.deadline
    )
      throw new CaseError(
        'BAD_SIGNATURE',
        'resolution does not match this case, its flags, or is expired',
      );
    const signer = await recoverCaseResolver(resolution, input.chainId);
    if (
      !signer ||
      !input.owners.some((o) => o.toLowerCase() === signer.toLowerCase())
    )
      throw new CaseError('BAD_SIGNATURE', 'not signed by the workspace owner');
    const at = this.now();
    const out = await this.update(caseId, (x) => {
      if (caseFlagsDigest(x) !== resolution.flagsDigest)
        throw new CaseError(
          'BAD_SIGNATURE',
          'case changed after resolution was signed',
        );
      return x.status === 'RELEASED' || x.status === 'RESOLVED'
        ? x
        : {
            ...x,
            status: 'RESOLVED',
            events: [
              ...x.events,
              {
                at,
                actor: signer,
                action: 'RESOLVED_BY_OWNER',
                note: `EIP-712 resolution ${resolution.signature.slice(0, 18)}…`,
              },
            ],
            rev: x.rev + 1,
          };
    });
    await this.record(out.workspaceId, signer, 'CASE_RESOLVED', {
      caseId,
      reason: 'owner-signed resolution',
      signature: resolution.signature,
    });
    return out;
  }

  /** The counterparty (or owner) appeals a blocked case: back to review, never released. */
  async appeal(caseId: string, by: string, note: string): Promise<RiskCase> {
    const at = this.now();
    const out = await this.update(caseId, (c) => {
      if (c.status !== 'BLOCKED')
        throw new CaseError('BAD_STATE', `cannot appeal a ${c.status} case`);
      return {
        ...c,
        status: 'APPEALED',
        events: [
          ...c.events,
          { at, actor: by, action: 'APPEALED', note: note.slice(0, 300) },
        ],
        rev: c.rev + 1,
      };
    });
    await this.record(out.workspaceId, by, 'CASE_APPEALED', { caseId, note });
    return out;
  }
}

/** Deterministic alert key: same rule set, subject and evidence = same alert. */
export function alertKeyOf(input: {
  subjectRef: string;
  codes: readonly string[];
  evidence: string;
}): string {
  return `alert_${createHash('sha256')
    .update(
      `${input.subjectRef}|${[...input.codes].sort().join(',')}|${input.evidence}`,
    )
    .digest('hex')
    .slice(0, 24)}`;
}
