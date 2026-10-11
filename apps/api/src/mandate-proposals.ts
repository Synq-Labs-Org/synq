import { createHash } from 'node:crypto';
import {
  encodeFunctionData,
  zeroAddress,
  type PublicClient,
  recoverTypedDataAddress,
  type Address,
  type Hex,
} from 'viem';
import { z } from 'zod';
import {
  MandateSchema,
  type Mandate,
  type MembershipDirectory,
} from '@synq/schemas';
import {
  KernelError,
  MandateResolver,
  artifactHash,
  narrowedFields,
  onchainMandateId,
  toMandateConfig,
} from '@synq/kernel';
import { registryAbi, safeAbi } from '@synq/execution-worker/abi';
import {
  safeTransactionHash,
  safeTransactionTypedData,
  type SafeGovernanceTransaction,
} from '@synq/identity/server';

export const MANDATE_PROPOSAL_STATES = [
  'PENDING',
  'READY',
  'EXECUTED',
  'REJECTED',
  'STALE',
] as const;
export type MandateProposalState = (typeof MANDATE_PROPOSAL_STATES)[number];
const Hash = z.string().regex(/^0x[0-9a-f]{64}$/);
const Addr = z.string().regex(/^0x[0-9a-f]{40}$/);

export const MandateProposalSchema = z.strictObject({
  proposalId: Hash,
  groupId: z.string().min(1).max(200),
  change: z.enum(['NEW', 'SUPERSEDE']),
  securitySensitive: z.boolean(),
  mandate: MandateSchema,
  mandateHash: Hash,
  safeTx: z.strictObject({
    safe: Addr,
    chainId: z.number().int().positive(),
    to: Addr,
    data: z.string().regex(/^0x[0-9a-f]*$/),
    nonce: z.string().regex(/^[0-9]+$/),
  }),
  safeTxHash: Hash,
  required: z.number().int().positive(),
  state: z.enum(MANDATE_PROPOSAL_STATES),
  proposedBy: z.strictObject({
    memberId: z.string().max(200).nullable(),
    source: z.enum(['BRAIN', 'OPERATOR']),
  }),
  executionTx: Hash.nullable(),
  reason: z.string().max(300).nullable(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});
export type MandateProposal = z.output<typeof MandateProposalSchema>;
export type MandateApproval = {
  proposalId: string;
  memberId: string;
  principalId: string;
  signer: Address;
  signature: Hex;
  membershipEpoch: number;
  verifiedAt: number;
};

export interface MandateProposalStore {
  create(p: MandateProposal): Promise<MandateProposal>;
  get(id: string): Promise<MandateProposal | null>;
  list(groupId?: string): Promise<MandateProposal[]>;
  save(p: MandateProposal): Promise<void>;
  addApproval(a: MandateApproval): Promise<void>;
  approvals(id: string): Promise<MandateApproval[]>;
}

export class MemoryMandateProposalStore implements MandateProposalStore {
  readonly proposals = new Map<string, MandateProposal>();
  readonly votes = new Map<string, MandateApproval[]>();
  async create(p: MandateProposal) {
    const existing = this.proposals.get(p.proposalId);
    if (existing) return existing;
    this.proposals.set(p.proposalId, p);
    return p;
  }
  async get(id: string) {
    return this.proposals.get(id) ?? null;
  }
  async list(groupId?: string) {
    return [...this.proposals.values()].filter(
      (p) => groupId === undefined || p.groupId === groupId,
    );
  }
  async save(p: MandateProposal) {
    this.proposals.set(p.proposalId, p);
  }
  async addApproval(a: MandateApproval) {
    const list = this.votes.get(a.proposalId) ?? [];
    if (!list.some((x) => x.memberId === a.memberId)) list.push(a);
    this.votes.set(a.proposalId, list);
  }
  async approvals(id: string) {
    return this.votes.get(id) ?? [];
  }
}

type Sql = {
  query(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
};
export class PostgresMandateProposalStore implements MandateProposalStore {
  constructor(private readonly pool: Sql) {}
  async migrate() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS synq_mandate_proposal (
        proposal_id text PRIMARY KEY, group_id text NOT NULL, state text NOT NULL,
        created_at bigint NOT NULL, data jsonb NOT NULL);
      CREATE INDEX IF NOT EXISTS synq_mandate_proposal_group ON synq_mandate_proposal (group_id);
      CREATE TABLE IF NOT EXISTS synq_mandate_approval (
        proposal_id text NOT NULL REFERENCES synq_mandate_proposal(proposal_id),
        member_id text NOT NULL, data jsonb NOT NULL, PRIMARY KEY (proposal_id, member_id));`);
  }
  async create(p: MandateProposal) {
    await this.pool.query(
      'INSERT INTO synq_mandate_proposal (proposal_id, group_id, state, created_at, data) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
      [p.proposalId, p.groupId, p.state, p.createdAt, JSON.stringify(p)],
    );
    return (await this.get(p.proposalId))!;
  }
  async get(id: string) {
    const r = await this.pool.query(
      'SELECT data FROM synq_mandate_proposal WHERE proposal_id=$1',
      [id],
    );
    return r.rows[0] ? MandateProposalSchema.parse(r.rows[0].data) : null;
  }
  async list(groupId?: string) {
    const r =
      groupId === undefined
        ? await this.pool.query(
            'SELECT data FROM synq_mandate_proposal ORDER BY created_at',
          )
        : await this.pool.query(
            'SELECT data FROM synq_mandate_proposal WHERE group_id=$1 ORDER BY created_at',
            [groupId],
          );
    return r.rows.map((x) => MandateProposalSchema.parse(x.data));
  }
  async save(p: MandateProposal) {
    await this.pool.query(
      'UPDATE synq_mandate_proposal SET state=$2, data=$3 WHERE proposal_id=$1',
      [p.proposalId, p.state, JSON.stringify(MandateProposalSchema.parse(p))],
    );
  }
  async addApproval(a: MandateApproval) {
    await this.pool.query(
      'INSERT INTO synq_mandate_approval (proposal_id, member_id, data) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
      [a.proposalId, a.memberId, JSON.stringify(a)],
    );
  }
  async approvals(id: string) {
    const r = await this.pool.query(
      'SELECT data FROM synq_mandate_approval WHERE proposal_id=$1 ORDER BY member_id',
      [id],
    );
    return r.rows.map((x) => x.data as MandateApproval);
  }
}

export class MandateProposalError extends Error {
  constructor(
    readonly code:
      | 'PROPOSAL_NOT_FOUND'
      | 'PROPOSAL_NOT_PENDING'
      | 'GROUP_NOT_FOUND'
      | 'MANDATE_INVALID'
      | 'NETWORK_MISMATCH'
      | 'NOT_A_MEMBER'
      | 'NOT_AN_OWNER'
      | 'SIGNATURE_INVALID'
      | 'SAFE_HASH_MISMATCH',
    message: string = code,
  ) {
    super(message);
    this.name = 'MandateProposalError';
  }
}

export type MandateProposalDeps = {
  store: MandateProposalStore;
  directory: MembershipDirectory;
  group(groupId: string): Promise<{
    account: Address;
    owners: readonly Address[];
    threshold: number;
    chainId: number;
  } | null>;
  /** Safe nonce and on-chain `getTransactionHash` for cross-checking the typed-data hash. */
  safe: {
    nonce(safe: Address): Promise<bigint>;
    transactionHash(tx: SafeGovernanceTransaction): Promise<Hex>;
  };
  registry: Address;
  chainId: number;
  /** Kernel policy check for the change (MandateResolver); throws on rejection. */
  kernelCheck(
    mandate: Mandate,
    change: 'NEW' | 'SUPERSEDE',
  ): { securitySensitive: boolean };
  now: () => number;
};

/**
 * Brain or operator mandate proposals become Safe governance transactions
 * that only verified member owners can approve; nothing here can execute.
 */
export class MandateProposalService {
  constructor(private readonly deps: MandateProposalDeps) {}

  async propose(input: {
    groupId: string;
    mandate: unknown;
    change: 'NEW' | 'SUPERSEDE';
    proposedBy: MandateProposal['proposedBy'];
  }): Promise<MandateProposal> {
    const parsed = MandateSchema.safeParse(input.mandate);
    if (!parsed.success) throw new MandateProposalError('MANDATE_INVALID');
    const mandate = parsed.data;
    const group = await this.deps.group(input.groupId);
    if (!group) throw new MandateProposalError('GROUP_NOT_FOUND');
    if (
      mandate.network.chainId !== this.deps.chainId ||
      group.chainId !== this.deps.chainId ||
      mandate.account.toLowerCase() !== group.account.toLowerCase()
    )
      throw new MandateProposalError('NETWORK_MISMATCH');
    let securitySensitive: boolean;
    try {
      ({ securitySensitive } = this.deps.kernelCheck(mandate, input.change));
    } catch (error) {
      throw new MandateProposalError(
        'MANDATE_INVALID',
        (error as { code?: string }).code ?? 'KERNEL_REJECTED',
      );
    }
    const id = onchainMandateId(mandate);
    const data =
      input.change === 'NEW'
        ? encodeFunctionData({
            abi: registryAbi,
            functionName: 'configureMandate',
            args: [id, toMandateConfig(mandate)],
          })
        : encodeFunctionData({
            abi: registryAbi,
            functionName: 'supersedeMandate',
            args: [
              id,
              BigInt(mandate.version),
              toMandateConfig(mandate),
              securitySensitive,
            ],
          });
    const nonce = await this.deps.safe.nonce(group.account);
    const tx: SafeGovernanceTransaction = {
      safe: group.account,
      chainId: this.deps.chainId,
      to: this.deps.registry,
      data,
      nonce,
    };
    const safeTxHash = safeTransactionHash(tx);
    if ((await this.deps.safe.transactionHash(tx)).toLowerCase() !== safeTxHash)
      throw new MandateProposalError('SAFE_HASH_MISMATCH');
    const mandateHash = artifactHash(mandate);
    const now = this.deps.now();
    return this.deps.store.create({
      proposalId: `0x${createHash('sha256').update(`${input.groupId}:${safeTxHash}`).digest('hex')}`,
      groupId: input.groupId,
      change: input.change,
      securitySensitive,
      mandate,
      mandateHash,
      safeTx: {
        safe: group.account.toLowerCase(),
        chainId: this.deps.chainId,
        to: this.deps.registry.toLowerCase(),
        data: data.toLowerCase(),
        nonce: nonce.toString(),
      },
      safeTxHash,
      required: group.threshold,
      state: 'PENDING',
      proposedBy: input.proposedBy,
      executionTx: null,
      reason: null,
      createdAt: now,
      updatedAt: now,
    });
  }

  private tx(p: MandateProposal): SafeGovernanceTransaction {
    return {
      safe: p.safeTx.safe as Address,
      chainId: p.safeTx.chainId,
      to: p.safeTx.to as Address,
      data: p.safeTx.data as Hex,
      nonce: BigInt(p.safeTx.nonce),
    };
  }

  private async load(id: string) {
    const p = await this.deps.store.get(id);
    if (!p) throw new MandateProposalError('PROPOSAL_NOT_FOUND');
    return p;
  }

  /** Approvals re-verified against current membership: a removed member no longer counts. */
  async counted(p: MandateProposal) {
    const group = await this.deps.group(p.groupId);
    const owners = new Set(group?.owners.map((o) => o.toLowerCase()) ?? []);
    const out: MandateApproval[] = [];
    for (const a of await this.deps.store.approvals(p.proposalId)) {
      const m = await this.deps.directory.activeMember(p.groupId, a.memberId);
      if (
        m &&
        m.principalId === a.principalId &&
        m.signer.toLowerCase() === a.signer.toLowerCase() &&
        m.membershipEpoch === a.membershipEpoch &&
        owners.has(a.signer.toLowerCase())
      )
        out.push(a);
    }
    return out;
  }

  async view(id: string) {
    const p = await this.load(id);
    const counted = await this.counted(p);
    return {
      proposal: p,
      counted: counted.map((a) => ({ memberId: a.memberId, signer: a.signer })),
      required: p.required,
    };
  }

  async approve(id: string, input: { memberId: string; signature: Hex }) {
    const p = await this.load(id);
    if (p.state !== 'PENDING' && p.state !== 'READY')
      throw new MandateProposalError('PROPOSAL_NOT_PENDING');
    const member = await this.deps.directory.activeMember(
      p.groupId,
      input.memberId,
    );
    if (!member) throw new MandateProposalError('NOT_A_MEMBER');
    const group = await this.deps.group(p.groupId);
    if (
      !group?.owners.some(
        (o) => o.toLowerCase() === member.signer.toLowerCase(),
      )
    )
      throw new MandateProposalError('NOT_AN_OWNER');
    let recovered: string;
    try {
      recovered = await recoverTypedDataAddress({
        ...safeTransactionTypedData(this.tx(p)),
        signature: input.signature,
      });
    } catch {
      throw new MandateProposalError('SIGNATURE_INVALID');
    }
    if (recovered.toLowerCase() !== member.signer.toLowerCase())
      throw new MandateProposalError('SIGNATURE_INVALID');
    await this.deps.store.addApproval({
      proposalId: p.proposalId,
      memberId: member.memberId,
      principalId: member.principalId,
      signer: member.signer.toLowerCase() as Address,
      signature: input.signature,
      membershipEpoch: member.membershipEpoch,
      verifiedAt: this.deps.now(),
    });
    const counted = await this.counted(p);
    if (p.state === 'PENDING' && counted.length >= p.required)
      await this.deps.store.save({
        ...p,
        state: 'READY',
        updatedAt: this.deps.now(),
      });
    return this.view(id);
  }

  /** Owner signatures ordered for Safe.execTransaction, or null below threshold. */
  async signatures(id: string): Promise<Hex | null> {
    const p = await this.load(id);
    const counted = (await this.counted(p))
      .sort((a, b) => (a.signer < b.signer ? -1 : 1))
      .slice(0, p.required);
    if (counted.length < p.required) return null;
    return `0x${counted.map((a) => a.signature.slice(2)).join('')}` as Hex;
  }

  async settle(
    id: string,
    outcome:
      | { state: 'EXECUTED'; transactionHash: Hex }
      | { state: 'STALE' | 'REJECTED'; reason: string },
  ) {
    const p = await this.load(id);
    await this.deps.store.save({
      ...p,
      state: outcome.state,
      executionTx:
        outcome.state === 'EXECUTED'
          ? (outcome.transactionHash.toLowerCase() as Hex)
          : null,
      reason:
        outcome.state === 'EXECUTED' ? null : outcome.reason.slice(0, 300),
      updatedAt: this.deps.now(),
    });
  }

  list(groupId?: string) {
    return this.deps.store.list(groupId);
  }
}

/** The Kernel's own mandate change rules, applied to a proposal before any owner signs. */
export function kernelMandateCheck(listMandates: () => readonly Mandate[]) {
  return (next: Mandate, change: 'NEW' | 'SUPERSEDE') => {
    const current = listMandates().find(
      (m) => m.groupId === next.groupId && m.mandateId === next.mandateId,
    );
    if (change === 'NEW') {
      if (current)
        throw new KernelError('INVALID_REQUEST', [
          { path: 'mandateId', message: 'MANDATE_CONFLICT' },
        ]);
      new MandateResolver().configure(next);
      return { securitySensitive: false };
    }
    if (!current)
      throw new KernelError('INVALID_REQUEST', [
        { path: 'mandateId', message: 'MANDATE_NOT_FOUND' },
      ]);
    const securitySensitive = narrowedFields(current, next).length > 0;
    new MandateResolver([current]).supersede(next, { securitySensitive });
    return { securitySensitive };
  };
}

/** Reads the Safe nonce and its own transaction hash for proposal construction. */
export function safeReader(client: PublicClient): MandateProposalDeps['safe'] {
  return {
    nonce: (safe) =>
      client.readContract({
        address: safe,
        abi: safeAbi,
        functionName: 'nonce',
      }),
    transactionHash: (tx) =>
      client.readContract({
        address: tx.safe,
        abi: safeAbi,
        functionName: 'getTransactionHash',
        args: [
          tx.to,
          0n,
          tx.data,
          0,
          0n,
          0n,
          0n,
          zeroAddress,
          zeroAddress,
          tx.nonce,
        ],
      }),
  };
}
