import {
  DealRoomError,
  type Attestation,
  type Deal,
  type DealSignature,
  type DealVersion,
  type Transition,
} from './schema.js';

/**
 * Durable Deal Room state. Versions, signatures, attestations and
 * transitions are append-only; only the deal head row (status, current
 * version, bindings) changes, and only through `commit`, which is atomic:
 *
 * - a transition whose idempotency key the deal already has is a no-op
 *   (DUPLICATE) and writes nothing;
 * - otherwise the deal must still be at `expectedRev` (optimistic lock), the
 *   new version / signature / attestation must not collide with an existing
 *   one (one decision per role and version; one use per attestation nonce
 *   and per milestone and kind), and everything is written together.
 */

export type Commit = Readonly<{
  dealId: string;
  expectedRev: number;
  /** The new head; its rev must be expectedRev + 1. */
  deal: Deal;
  transition: Transition;
  version?: DealVersion;
  signature?: DealSignature;
  attestation?: Attestation;
}>;

export type CommitOutcome = Readonly<{
  outcome: 'APPLIED' | 'DUPLICATE';
  deal: Deal;
}>;

export interface DealRoomStore {
  migrate(): Promise<void>;
  /** Inserts a new deal with its first version and transition; DUPLICATE when the deal id exists. */
  create(input: {
    deal: Deal;
    version: DealVersion;
    transition: Transition;
  }): Promise<CommitOutcome>;
  commit(c: Commit): Promise<CommitOutcome>;
  get(dealId: string): Promise<Deal | null>;
  versions(dealId: string): Promise<DealVersion[]>;
  signatures(dealId: string): Promise<DealSignature[]>;
  attestations(dealId: string): Promise<Attestation[]>;
  transitions(dealId: string): Promise<Transition[]>;
  list(workspaceId: string): Promise<Deal[]>;
}

const clone = <T>(v: T): T => structuredClone(v);

/** In-memory store; each method body has no await between check and write. */
export class MemoryDealRoomStore implements DealRoomStore {
  private deals = new Map<string, Deal>();
  private vers = new Map<string, DealVersion[]>();
  private sigs = new Map<string, DealSignature[]>();
  private atts = new Map<string, Attestation[]>();
  private trans = new Map<string, Transition[]>();
  private nonces = new Set<string>();

  async migrate() {}

  async create(input: {
    deal: Deal;
    version: DealVersion;
    transition: Transition;
  }): Promise<CommitOutcome> {
    const d = input.deal;
    const existing = this.deals.get(d.dealId);
    if (existing) return { outcome: 'DUPLICATE', deal: clone(existing) };
    this.deals.set(d.dealId, clone(d));
    this.vers.set(d.dealId, [clone(input.version)]);
    this.sigs.set(d.dealId, []);
    this.atts.set(d.dealId, []);
    this.trans.set(d.dealId, [clone(input.transition)]);
    return { outcome: 'APPLIED', deal: clone(d) };
  }

  async commit(c: Commit): Promise<CommitOutcome> {
    const cur = this.deals.get(c.dealId);
    if (!cur) throw new DealRoomError('NOT_FOUND', c.dealId);
    const trans = this.trans.get(c.dealId)!;
    if (trans.some((t) => t.idempotencyKey === c.transition.idempotencyKey))
      return { outcome: 'DUPLICATE', deal: clone(cur) };
    if (cur.rev !== c.expectedRev || c.deal.rev !== c.expectedRev + 1)
      throw new DealRoomError(
        'CONFLICT',
        `deal ${c.dealId} is at rev ${cur.rev}, expected ${c.expectedRev}`,
      );
    const vers = this.vers.get(c.dealId)!;
    const sigs = this.sigs.get(c.dealId)!;
    const atts = this.atts.get(c.dealId)!;
    if (c.version && vers.some((v) => v.version === c.version!.version))
      throw new DealRoomError(
        'CONFLICT',
        `version ${c.version.version} exists`,
      );
    if (
      c.signature &&
      sigs.some(
        (s) =>
          s.version === c.signature!.version &&
          s.role === c.signature!.role &&
          s.decision === c.signature!.decision,
      )
    )
      throw new DealRoomError('REPLAYED', 'this decision is already recorded');
    if (c.attestation) {
      const a = c.attestation;
      if (
        this.nonces.has(a.nonce.toLowerCase()) ||
        atts.some((x) => x.milestone === a.milestone && x.kind === a.kind)
      )
        throw new DealRoomError('REPLAYED', 'attestation already used');
    }
    if (c.version) vers.push(clone(c.version));
    if (c.signature) sigs.push(clone(c.signature));
    if (c.attestation) {
      this.nonces.add(c.attestation.nonce.toLowerCase());
      atts.push(clone(c.attestation));
    }
    trans.push(clone(c.transition));
    this.deals.set(c.dealId, clone(c.deal));
    return { outcome: 'APPLIED', deal: clone(c.deal) };
  }

  async get(dealId: string) {
    const d = this.deals.get(dealId);
    return d ? clone(d) : null;
  }
  async versions(dealId: string) {
    return clone(this.vers.get(dealId) ?? []);
  }
  async signatures(dealId: string) {
    return clone(this.sigs.get(dealId) ?? []);
  }
  async attestations(dealId: string) {
    return clone(this.atts.get(dealId) ?? []);
  }
  async transitions(dealId: string) {
    return clone(this.trans.get(dealId) ?? []);
  }
  async list(workspaceId: string) {
    return [...this.deals.values()]
      .filter((d) => d.workspaceId === workspaceId)
      .map(clone);
  }
}
