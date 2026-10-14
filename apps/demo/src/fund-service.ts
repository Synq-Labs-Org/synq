import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  keccak256,
  stringToHex,
  verifyTypedData,
  type Address,
  type Hex,
} from 'viem';
import {
  safeTransactionHash,
  safeTransactionTypedData,
  verifyFundJoin,
  type SafeGovernanceTransaction,
} from '@synq/identity';
import type { SendRecord } from '@synq/funding';
import type { IdentityChallenge, Mandate } from '@synq/schemas';

/**
 * Group funds started from the Messages app. A fund forms off-chain (people join
 * with their passkeys), then launches once: the operator deploys the Safe with
 * every joined member as an owner. Each member activates with one passkey
 * ceremony that signs their group membership and the setup Safe transactions
 * (executor and spending mandate); once enough owners have signed, the operator
 * relays them and the fund goes live with starter test AUSD.
 *
 * Two bearer secrets travel in the chat's cards: the fund key (read the fund,
 * join while forming) and the creator's admin key (launch). Neither moves
 * money: every payment still needs member passkey approvals.
 */

export const FUND_LIMITS = {
  minMembers: 2,
  maxMembers: 8,
  threshold: 2,
  // Room for a test-mode hotel stay (about 230 USD, settled 1:1 in AUSD).
  perActionCap: 500_000_000n,
  cumulativeBudget: 2_000_000_000n,
  reviewMax: 0n,
  validSeconds: 30 * 86_400,
  maxExecutions: 100,
  starterUnits: 5_000_000n,
  faucetUnits: 50_000_000n,
  faucetMaxUnits: 400_000_000n,
  /** Fund launches stop when the operator's testnet gas is below this. */
  minOperatorWei: 400_000_000_000_000_000n,
  createsPerDay: 40,
  launchesPerDay: 8,
  joinWindowSeconds: 600,
  maxAttempts: 3,
} as const;

export type FundState = 'FORMING' | 'LAUNCHING' | 'SETUP' | 'ACTIVE' | 'FAILED';

export type FundMember = {
  principalId: string;
  signer: Address;
  name: string;
  joinedAt: number;
  memberId: string | null;
  joinedGroup: boolean;
  challengeId: string | null;
};

export type FundSetupTx = {
  to: Address;
  data: Hex;
  nonce: string;
  safeTxHash: Hex;
  executedTx: Hex | null;
};

export type Fund = {
  schemaVersion: 1;
  fundId: string;
  name: string;
  keyHash: string;
  adminKeyHash: string;
  state: FundState;
  createdAt: number;
  updatedAt: number;
  launchedAt: number | null;
  members: FundMember[];
  group: {
    chainGroupId: Hex;
    account: Address;
    blockNumber: string;
    threshold: number;
  } | null;
  mandate: Mandate | null;
  setup: {
    transactions: FundSetupTx[];
    /** safeTxHash -> lowercase signer -> signature */
    signatures: Record<string, Record<string, Hex>>;
  } | null;
  funding: { requested: string; sent: string; txs: Hex[] };
  attempts: number;
  error: string | null;
};

export interface FundStore {
  migrate(): Promise<void>;
  create(fund: Fund): Promise<void>;
  get(fundId: string): Promise<Fund | null>;
  /** Serialized read-modify-write of one fund; `change` returns the new document. */
  mutate(
    fundId: string,
    change: (fund: Fund) => Fund | Promise<Fund>,
  ): Promise<Fund>;
  /** Funds the operator loop has work for. */
  pending(): Promise<Fund[]>;
  createdSince(at: number): Promise<number>;
  launchedSince(at: number): Promise<number>;
}

export type FundRecipientView = { name: string; recipientId: string };

export type FundProposalView = {
  intentHash: string;
  state: 'PENDING' | 'EXECUTING' | 'PAID' | 'REJECTED';
  amount: string;
  symbol: string;
  recipient: string;
  sender: string | null;
  approvals: { counted: number; required: number; names: string[] };
  transactionHash: string | null;
  explorer: string | null;
  createdAt: number;
};

export type FundView = {
  fundId: string;
  name: string;
  state: FundState;
  error: string | null;
  createdAt: number;
  members: {
    name: string;
    principalId: string;
    memberId: string | null;
    activated: boolean;
    signedSetup: boolean;
  }[];
  minMembers: number;
  maxMembers: number;
  threshold: number;
  group: { chainGroupId: string; account: string } | null;
  setup: { signed: number; required: number } | null;
  treasury: { balance: string; symbol: string } | null;
  recipients: FundRecipientView[];
  proposals: FundProposalView[];
  canRequestTestFunds: boolean;
  /** Largest single payment the fund's mandate allows, as a decimal. */
  maxPayment: string;
};

export type FundPorts = {
  now(): number;
  chainId: number;
  operator: Address;
  asset: Mandate['inputAsset'];
  principal(
    principalId: string,
  ): Promise<{ signer: Address; kind: string; status: string } | null>;
  operatorGas(): Promise<bigint>;
  createGroup(
    owners: readonly Address[],
    salt: Hex,
  ): Promise<{ chainGroupId: Hex; account: Address; blockNumber: bigint }>;
  bindGroup(group: {
    chainGroupId: Hex;
    account: Address;
    owners: readonly Address[];
    threshold: number;
  }): Promise<void>;
  joinChallenge(
    groupId: string,
    memberId: string,
    principalId: string,
  ): Promise<IdentityChallenge>;
  join(groupId: string, challengeId: string, signature: Hex): Promise<void>;
  safeNonce(account: Address): Promise<bigint>;
  /** Relays an owner-signed Safe transaction; resolves to its transaction hash. */
  execSafe(
    account: Address,
    tx: SafeGovernanceTransaction,
    signatures: readonly { signer: Address; signature: Hex }[],
  ): Promise<Hex>;
  setupCalls(mandate: Mandate): { to: Address; data: Hex; step: string }[];
  mandate(input: {
    chainGroupId: Hex;
    account: Address;
    members: { memberId: string; signer: Address }[];
    now: number;
  }): Mandate;
  /** Registers the executed mandate with the read model and the Kernel. */
  activateMandate(mandate: Mandate): Promise<void>;
  transfer(account: Address, units: bigint): Promise<Hex>;
  treasury(account: Address): Promise<bigint>;
  sends(groupId: string, limit: number): Promise<SendRecord[]>;
  quorum(
    draftDigest: string,
  ): Promise<{ memberIds: string[]; required: number } | null>;
  explorer(hash: string): string;
  log(message: string): void;
};

export class FundError extends Error {
  constructor(
    readonly code:
      | 'INVALID_REQUEST'
      | 'FUND_NOT_FOUND'
      | 'FORBIDDEN'
      | 'WRONG_STATE'
      | 'FUND_FULL'
      | 'NOT_ENOUGH_MEMBERS'
      | 'ALREADY_MEMBER'
      | 'NOT_A_MEMBER'
      | 'PRINCIPAL_NOT_ELIGIBLE'
      | 'BAD_SIGNATURE'
      | 'STALE_SIGNATURE'
      | 'RATE_LIMITED'
      | 'FAUCET_LIMIT'
      | 'OPERATOR_OUT_OF_GAS',
    readonly status: number,
    message: string = code,
  ) {
    super(message);
    this.name = 'FundError';
  }
}

const hashKey = (key: string) =>
  createHash('sha256').update(`synq.fund.key:${key}`).digest('hex');
const newKey = () => randomBytes(24).toString('base64url');

function keyMatches(key: string, hash: string): boolean {
  const a = Buffer.from(hashKey(key), 'hex');
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Printable single-line text, trimmed and collapsed; null when out of bounds. */
export function cleanName(raw: unknown, max: number): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.normalize('NFC').replace(/\s+/g, ' ').trim();
  if (!s || s.length > max || /[\p{Cc}\p{Cf}]/u.test(s)) return null;
  return s;
}

const lower = (a: string) => a.toLowerCase() as Address;

function formatUnits(units: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals);
  const whole = units / base;
  const frac = (units % base)
    .toString()
    .padStart(decimals, '0')
    .replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : String(whole);
}

function proposalState(
  s: SendRecord['state'],
): FundProposalView['state'] | null {
  switch (s) {
    case 'PENDING_APPROVAL':
      return 'PENDING';
    case 'AUTHORIZED':
    case 'SUBMITTED':
      return 'EXECUTING';
    case 'CONFIRMED':
    case 'INDEXED':
      return 'PAID';
    case 'REJECTED':
      return 'REJECTED';
    default:
      return null;
  }
}

export class FundService {
  constructor(
    readonly store: FundStore,
    readonly ports: FundPorts,
  ) {}

  private async load(fundId: string, key: string): Promise<Fund> {
    const fund = await this.store.get(fundId);
    if (!fund) throw new FundError('FUND_NOT_FOUND', 404);
    if (!keyMatches(key, fund.keyHash)) throw new FundError('FORBIDDEN', 403);
    return fund;
  }

  private authorize(fund: Fund, key: string): Fund {
    if (!keyMatches(key, fund.keyHash)) throw new FundError('FORBIDDEN', 403);
    return fund;
  }

  async create(input: {
    name: unknown;
  }): Promise<{ fundId: string; key: string; adminKey: string }> {
    const name = cleanName(input.name, 40);
    if (!name) throw new FundError('INVALID_REQUEST', 400, 'fund name');
    const now = this.ports.now();
    if (
      (await this.store.createdSince(now - 86_400)) >= FUND_LIMITS.createsPerDay
    )
      throw new FundError('RATE_LIMITED', 429);
    const fundId = `fnd_${randomBytes(10).toString('hex')}`;
    const key = newKey();
    const adminKey = newKey();
    await this.store.create({
      schemaVersion: 1,
      fundId,
      name,
      keyHash: hashKey(key),
      adminKeyHash: hashKey(adminKey),
      state: 'FORMING',
      createdAt: now,
      updatedAt: now,
      launchedAt: null,
      members: [],
      group: null,
      mandate: null,
      setup: null,
      funding: { requested: '0', sent: '0', txs: [] },
      attempts: 0,
      error: null,
    });
    this.ports.log(`fund ${fundId} created`);
    return { fundId, key, adminKey };
  }

  async view(fundId: string, key: string): Promise<FundView> {
    const fund = await this.load(fundId, key);
    const byMemberId = new Map(
      fund.members.filter((m) => m.memberId).map((m) => [m.memberId!, m.name]),
    );
    const bySigner = new Map(
      fund.members.map((m) => [lower(m.signer), m.name]),
    );
    const setupSigners = (signer: Address) =>
      !!fund.setup &&
      fund.setup.transactions.every(
        (t) => fund.setup!.signatures[t.safeTxHash]?.[lower(signer)],
      );
    let treasury: FundView['treasury'] = null;
    let proposals: FundProposalView[] = [];
    if (fund.group && fund.state === 'ACTIVE') {
      const [balance, sends] = await Promise.all([
        this.ports.treasury(fund.group.account).catch(() => null),
        this.ports.sends(fund.group.chainGroupId, 20).catch(() => []),
      ]);
      if (balance !== null)
        treasury = {
          balance: formatUnits(balance, this.ports.asset.decimals),
          symbol: this.ports.asset.symbol,
        };
      proposals = (
        await Promise.all(
          sends.map(async (s): Promise<FundProposalView | null> => {
            const state = proposalState(s.state);
            if (!state || !s.intentHash) return null;
            const quorum = s.draftDigest
              ? await this.ports.quorum(s.draftDigest).catch(() => null)
              : null;
            const names = (quorum?.memberIds ?? []).map(
              (id) => byMemberId.get(id) ?? id,
            );
            const tx = s.receipt?.transactionHash ?? null;
            return {
              intentHash: s.intentHash,
              state,
              amount: s.preview.amountDecimal,
              symbol: s.preview.asset.symbol,
              recipient:
                bySigner.get(lower(s.preview.recipient.address)) ??
                s.preview.recipient.label,
              sender: s.sender
                ? (byMemberId.get(s.sender.memberId) ?? null)
                : null,
              approvals: {
                counted: names.length,
                required: quorum?.required ?? fund.group!.threshold,
                names,
              },
              transactionHash: tx,
              explorer: tx ? this.ports.explorer(tx) : null,
              createdAt: s.history[0]?.at ?? 0,
            };
          }),
        )
      ).filter((p): p is FundProposalView => p !== null);
    }
    const required = fund.group?.threshold ?? FUND_LIMITS.threshold;
    return {
      fundId: fund.fundId,
      name: fund.name,
      state: fund.state,
      error: fund.error,
      createdAt: fund.createdAt,
      members: fund.members.map((m) => ({
        name: m.name,
        principalId: m.principalId,
        memberId: m.memberId,
        activated: m.joinedGroup,
        signedSetup: setupSigners(m.signer),
      })),
      minMembers: FUND_LIMITS.minMembers,
      maxMembers: FUND_LIMITS.maxMembers,
      threshold: required,
      group: fund.group
        ? {
            chainGroupId: fund.group.chainGroupId,
            account: fund.group.account,
          }
        : null,
      setup: fund.setup
        ? {
            signed: fund.members.filter((m) => setupSigners(m.signer)).length,
            required,
          }
        : null,
      treasury,
      recipients:
        fund.state === 'ACTIVE'
          ? fund.members
              .filter((m) => m.memberId)
              .map((m) => ({
                name: m.name,
                recipientId: `member:${m.memberId}`,
              }))
          : [],
      proposals,
      maxPayment: formatUnits(
        FUND_LIMITS.perActionCap,
        this.ports.asset.decimals,
      ),
      canRequestTestFunds:
        fund.state === 'ACTIVE' &&
        BigInt(fund.funding.requested) + FUND_LIMITS.faucetUnits <=
          FUND_LIMITS.faucetMaxUnits + FUND_LIMITS.starterUnits,
    };
  }

  async join(
    fundId: string,
    input: {
      key: string;
      principalId: string;
      name: unknown;
      issuedAt: number;
      signature: Hex;
    },
  ): Promise<FundView> {
    await this.load(fundId, input.key);
    const name = cleanName(input.name, 32);
    if (!name) throw new FundError('INVALID_REQUEST', 400, 'display name');
    const now = this.ports.now();
    if (Math.abs(now - input.issuedAt) > FUND_LIMITS.joinWindowSeconds)
      throw new FundError('STALE_SIGNATURE', 400);
    const principal = await this.ports.principal(input.principalId);
    if (
      !principal ||
      principal.status !== 'ACTIVE' ||
      principal.kind !== 'MERA_HUMAN'
    )
      throw new FundError('PRINCIPAL_NOT_ELIGIBLE', 403);
    const ok = await verifyFundJoin(
      {
        fundId,
        principalId: input.principalId,
        name,
        issuedAt: input.issuedAt,
      },
      principal.signer,
      input.signature,
    );
    if (!ok) throw new FundError('BAD_SIGNATURE', 403);
    await this.store.mutate(fundId, (fund) => {
      if (fund.state !== 'FORMING')
        throw new FundError(
          'WRONG_STATE',
          409,
          'the fund has already launched',
        );
      if (
        fund.members.some(
          (m) =>
            m.principalId === input.principalId ||
            lower(m.signer) === lower(principal.signer),
        )
      )
        throw new FundError('ALREADY_MEMBER', 409);
      if (fund.members.length >= FUND_LIMITS.maxMembers)
        throw new FundError('FUND_FULL', 409);
      return {
        ...fund,
        updatedAt: now,
        members: [
          ...fund.members,
          {
            principalId: input.principalId,
            signer: lower(principal.signer),
            name,
            joinedAt: now,
            memberId: null,
            joinedGroup: false,
            challengeId: null,
          },
        ],
      };
    });
    this.ports.log(`fund ${fundId}: member joined`);
    return this.view(fundId, input.key);
  }

  async launch(fundId: string, adminKey: string): Promise<void> {
    const now = this.ports.now();
    await this.store.mutate(fundId, async (fund) => {
      if (!keyMatches(adminKey, fund.adminKeyHash))
        throw new FundError('FORBIDDEN', 403);
      const retry = fund.state === 'FAILED' && !fund.setup;
      if (fund.state !== 'FORMING' && !retry)
        throw new FundError('WRONG_STATE', 409);
      if (fund.members.length < FUND_LIMITS.minMembers)
        throw new FundError('NOT_ENOUGH_MEMBERS', 409);
      if (
        !retry &&
        (await this.store.launchedSince(now - 86_400)) >=
          FUND_LIMITS.launchesPerDay
      )
        throw new FundError('RATE_LIMITED', 429);
      if ((await this.ports.operatorGas()) < FUND_LIMITS.minOperatorWei)
        throw new FundError('OPERATOR_OUT_OF_GAS', 503);
      return {
        ...fund,
        state: 'LAUNCHING',
        launchedAt: fund.launchedAt ?? now,
        updatedAt: now,
        attempts: 0,
        error: null,
        members: fund.members.map((m, i) => ({
          ...m,
          memberId: `member_${i}`,
        })),
      };
    });
    this.ports.log(`fund ${fundId}: launch requested`);
  }

  /** What the member signs in their one activation ceremony. */
  async activationChallenge(
    fundId: string,
    input: { key: string; principalId: string },
  ): Promise<{
    challenge: IdentityChallenge | null;
    safeTransactions: (Omit<SafeGovernanceTransaction, 'nonce'> & {
      nonce: string;
    })[];
  }> {
    const fund = await this.load(fundId, input.key);
    if ((fund.state !== 'SETUP' && fund.state !== 'ACTIVE') || !fund.group)
      throw new FundError('WRONG_STATE', 409);
    const member = fund.members.find(
      (m) => m.principalId === input.principalId,
    );
    if (!member?.memberId) throw new FundError('NOT_A_MEMBER', 403);
    let challenge: IdentityChallenge | null = null;
    if (!member.joinedGroup) {
      challenge = await this.ports.joinChallenge(
        fund.group.chainGroupId,
        member.memberId,
        member.principalId,
      );
      await this.store.mutate(fundId, (f) => ({
        ...f,
        members: f.members.map((m) =>
          m.principalId === member.principalId
            ? { ...m, challengeId: challenge!.challengeId }
            : m,
        ),
      }));
    }
    const pendingSetup =
      fund.state === 'SETUP' && fund.setup
        ? fund.setup.transactions.filter(
            (t) =>
              !t.executedTx &&
              !fund.setup!.signatures[t.safeTxHash]?.[lower(member.signer)],
          )
        : [];
    return {
      challenge,
      safeTransactions: pendingSetup.map((t) => ({
        safe: fund.group!.account,
        chainId: this.ports.chainId,
        to: t.to,
        data: t.data,
        nonce: t.nonce,
      })),
    };
  }

  async activate(
    fundId: string,
    input: {
      key: string;
      principalId: string;
      joinSignature: Hex | null;
      safeSignatures: { safeTxHash: Hex; signature: Hex }[];
    },
  ): Promise<FundView> {
    const fund = await this.load(fundId, input.key);
    if ((fund.state !== 'SETUP' && fund.state !== 'ACTIVE') || !fund.group)
      throw new FundError('WRONG_STATE', 409);
    const member = fund.members.find(
      (m) => m.principalId === input.principalId,
    );
    if (!member?.memberId) throw new FundError('NOT_A_MEMBER', 403);
    const verified: Record<string, Hex> = {};
    for (const { safeTxHash, signature } of input.safeSignatures) {
      const tx = fund.setup?.transactions.find(
        (t) => t.safeTxHash === safeTxHash,
      );
      if (!tx)
        throw new FundError(
          'INVALID_REQUEST',
          400,
          'unknown setup transaction',
        );
      const typed = safeTransactionTypedData({
        safe: fund.group.account,
        chainId: this.ports.chainId,
        to: tx.to,
        data: tx.data,
        nonce: BigInt(tx.nonce),
      });
      const ok = await verifyTypedData({
        address: member.signer,
        signature,
        ...typed,
      }).catch(() => false);
      if (!ok) throw new FundError('BAD_SIGNATURE', 403);
      verified[safeTxHash] = signature;
    }
    if (input.joinSignature && !member.joinedGroup) {
      if (!member.challengeId) throw new FundError('WRONG_STATE', 409);
      await this.ports.join(
        fund.group.chainGroupId,
        member.challengeId,
        input.joinSignature,
      );
    }
    await this.store.mutate(fundId, (f) => {
      const signatures = { ...(f.setup?.signatures ?? {}) };
      for (const [h, sig] of Object.entries(verified))
        signatures[h] = {
          ...(signatures[h] ?? {}),
          [lower(member.signer)]: sig,
        };
      return {
        ...f,
        updatedAt: this.ports.now(),
        setup: f.setup ? { ...f.setup, signatures } : f.setup,
        members: f.members.map((m) =>
          m.principalId === member.principalId
            ? {
                ...m,
                joinedGroup: m.joinedGroup || !!input.joinSignature,
                challengeId: input.joinSignature ? null : m.challengeId,
              }
            : m,
        ),
      };
    });
    this.ports.log(`fund ${fundId}: member activated`);
    return this.view(fundId, input.key);
  }

  async requestTestFunds(fundId: string, key: string): Promise<FundView> {
    await this.load(fundId, key);
    await this.store.mutate(fundId, (f) => {
      if (f.state !== 'ACTIVE') throw new FundError('WRONG_STATE', 409);
      const requested = BigInt(f.funding.requested) + FUND_LIMITS.faucetUnits;
      if (requested > FUND_LIMITS.faucetMaxUnits + FUND_LIMITS.starterUnits)
        throw new FundError('FAUCET_LIMIT', 409);
      return {
        ...f,
        updatedAt: this.ports.now(),
        funding: { ...f.funding, requested: String(requested) },
      };
    });
    return this.view(fundId, key);
  }

  /**
   * Runs pending operator work: launches, setup relays and test-fund transfers.
   * Called from the runner's operator loop so operator transactions never race.
   */
  async tick(): Promise<void> {
    for (const pending of await this.store.pending()) {
      try {
        if (pending.state === 'LAUNCHING') await this.runLaunch(pending.fundId);
        else if (pending.state === 'SETUP') await this.runSetup(pending.fundId);
        else if (pending.state === 'ACTIVE')
          await this.runFunding(pending.fundId);
      } catch (error) {
        const message = String(
          error instanceof Error ? error.message : error,
        ).slice(0, 240);
        this.ports.log(`fund ${pending.fundId}: ${message}`);
        await this.store.mutate(pending.fundId, (f) => {
          const attempts = f.attempts + 1;
          return {
            ...f,
            attempts,
            error: message,
            updatedAt: this.ports.now(),
            state:
              attempts >= FUND_LIMITS.maxAttempts && f.state !== 'ACTIVE'
                ? 'FAILED'
                : f.state,
          };
        });
      }
    }
  }

  private async runLaunch(fundId: string): Promise<void> {
    let fund = (await this.store.get(fundId))!;
    const owners = fund.members.map((m) => m.signer);
    if (!fund.group) {
      const created = await this.ports.createGroup(
        owners,
        keccak256(stringToHex(`synq.fund.${fund.fundId}`)),
      );
      fund = await this.store.mutate(fundId, (f) => ({
        ...f,
        group: {
          chainGroupId: created.chainGroupId,
          account: lower(created.account),
          blockNumber: String(created.blockNumber),
          threshold: FUND_LIMITS.threshold,
        },
      }));
      this.ports.log(`fund ${fundId}: Safe ${created.account}`);
    }
    const group = fund.group!;
    await this.ports.bindGroup({
      chainGroupId: group.chainGroupId,
      account: group.account,
      owners,
      threshold: group.threshold,
    });
    const mandate = this.ports.mandate({
      chainGroupId: group.chainGroupId,
      account: group.account,
      members: fund.members.map((m) => ({
        memberId: m.memberId!,
        signer: m.signer,
      })),
      now: this.ports.now(),
    });
    const nonce = await this.ports.safeNonce(group.account);
    const transactions = this.ports
      .setupCalls(mandate)
      .map((call, i): FundSetupTx => {
        const n = nonce + BigInt(i);
        return {
          to: call.to,
          data: call.data,
          nonce: String(n),
          safeTxHash: safeTransactionHash({
            safe: group.account,
            chainId: this.ports.chainId,
            to: call.to,
            data: call.data,
            nonce: n,
          }),
          executedTx: null,
        };
      });
    await this.store.mutate(fundId, (f) => ({
      ...f,
      state: 'SETUP',
      mandate,
      setup: { transactions, signatures: {} },
      attempts: 0,
      error: null,
      updatedAt: this.ports.now(),
    }));
    this.ports.log(`fund ${fundId}: waiting for owner activations`);
  }

  private async runSetup(fundId: string): Promise<void> {
    const fund = (await this.store.get(fundId))!;
    const { setup, group, mandate } = fund;
    if (!setup || !group || !mandate) return;
    const ready = setup.transactions.every(
      (t) =>
        t.executedTx ||
        Object.keys(setup.signatures[t.safeTxHash] ?? {}).length >=
          group.threshold,
    );
    if (!ready) return;
    const steps = this.ports.setupCalls(mandate);
    for (const [i, t] of setup.transactions.entries()) {
      if (t.executedTx) continue;
      const onchain = await this.ports.safeNonce(group.account);
      let hash: Hex;
      if (onchain > BigInt(t.nonce)) hash = '0x' as Hex;
      else {
        const signatures = Object.entries(setup.signatures[t.safeTxHash]!)
          .slice(0, group.threshold)
          .map(([signer, signature]) => ({
            signer: signer as Address,
            signature,
          }));
        hash = await this.ports.execSafe(
          group.account,
          {
            safe: group.account,
            chainId: this.ports.chainId,
            to: t.to,
            data: t.data,
            nonce: BigInt(t.nonce),
          },
          signatures,
        );
        this.ports.log(`fund ${fundId}: ${steps[i]?.step ?? 'setup'} ${hash}`);
      }
      await this.store.mutate(fundId, (f) => ({
        ...f,
        setup: {
          ...f.setup!,
          transactions: f.setup!.transactions.map((x) =>
            x.safeTxHash === t.safeTxHash ? { ...x, executedTx: hash } : x,
          ),
        },
      }));
    }
    await this.ports.activateMandate(mandate);
    await this.store.mutate(fundId, (f) => ({
      ...f,
      state: 'ACTIVE',
      attempts: 0,
      error: null,
      updatedAt: this.ports.now(),
      funding: {
        ...f.funding,
        requested: String(
          BigInt(f.funding.requested) + FUND_LIMITS.starterUnits,
        ),
      },
    }));
    this.ports.log(`fund ${fundId}: active`);
  }

  private async runFunding(fundId: string): Promise<void> {
    const fund = (await this.store.get(fundId))!;
    const due = BigInt(fund.funding.requested) - BigInt(fund.funding.sent);
    if (due <= 0n || !fund.group) return;
    const hash = await this.ports.transfer(fund.group.account, due);
    await this.store.mutate(fundId, (f) => ({
      ...f,
      updatedAt: this.ports.now(),
      funding: {
        ...f.funding,
        sent: String(BigInt(f.funding.sent) + due),
        txs: [...f.funding.txs, hash],
      },
    }));
    this.ports.log(`fund ${fundId}: test AUSD ${hash}`);
  }
}

/** In-memory store for tests. */
export class MemoryFundStore implements FundStore {
  private funds = new Map<string, Fund>();
  private queue: Promise<unknown> = Promise.resolve();
  async migrate() {}
  async create(fund: Fund) {
    if (this.funds.has(fund.fundId)) throw new Error('duplicate fund');
    this.funds.set(fund.fundId, structuredClone(fund));
  }
  async get(fundId: string) {
    const f = this.funds.get(fundId);
    return f ? structuredClone(f) : null;
  }
  mutate(fundId: string, change: (fund: Fund) => Fund | Promise<Fund>) {
    const run = this.queue.then(async () => {
      const f = this.funds.get(fundId);
      if (!f) throw new FundError('FUND_NOT_FOUND', 404);
      const next = await change(structuredClone(f));
      this.funds.set(fundId, structuredClone(next));
      return structuredClone(next);
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
  async pending() {
    return [...this.funds.values()]
      .filter(needsWork)
      .map((f) => structuredClone(f));
  }
  async createdSince(at: number) {
    return [...this.funds.values()].filter((f) => f.createdAt >= at).length;
  }
  async launchedSince(at: number) {
    return [...this.funds.values()].filter(
      (f) => f.launchedAt !== null && f.launchedAt >= at,
    ).length;
  }
}

export function needsWork(f: Fund): boolean {
  if (f.state === 'LAUNCHING' || f.state === 'SETUP') return true;
  return (
    f.state === 'ACTIVE' && BigInt(f.funding.requested) > BigInt(f.funding.sent)
  );
}

type SqlClient = {
  query(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
};
type Queryable = SqlClient & {
  connect(): Promise<SqlClient & { release(): void }>;
};

export class PostgresFundStore implements FundStore {
  constructor(readonly pool: Queryable) {}
  async migrate() {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS synq_funds (
      fund_id text PRIMARY KEY, state text NOT NULL, created_at bigint NOT NULL,
      launched_at bigint, data jsonb NOT NULL)`);
  }
  async create(fund: Fund) {
    await this.pool.query(
      'INSERT INTO synq_funds (fund_id,state,created_at,launched_at,data) VALUES ($1,$2,$3,$4,$5)',
      [fund.fundId, fund.state, fund.createdAt, fund.launchedAt, fund],
    );
  }
  async get(fundId: string) {
    const r = await this.pool.query(
      'SELECT data FROM synq_funds WHERE fund_id=$1',
      [fundId],
    );
    return (r.rows[0]?.data as Fund | undefined) ?? null;
  }
  async mutate(fundId: string, change: (fund: Fund) => Fund | Promise<Fund>) {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const r = await c.query(
        'SELECT data FROM synq_funds WHERE fund_id=$1 FOR UPDATE',
        [fundId],
      );
      const current = r.rows[0]?.data as Fund | undefined;
      if (!current) throw new FundError('FUND_NOT_FOUND', 404);
      const next = await change(current);
      await c.query(
        'UPDATE synq_funds SET state=$2, launched_at=$3, data=$4 WHERE fund_id=$1',
        [fundId, next.state, next.launchedAt, next],
      );
      await c.query('COMMIT');
      return next;
    } catch (error) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      c.release();
    }
  }
  async pending() {
    const r = await this.pool.query(
      `SELECT data FROM synq_funds WHERE state IN ('LAUNCHING','SETUP')
       OR (state='ACTIVE' AND (data->'funding'->>'requested')::numeric > (data->'funding'->>'sent')::numeric)
       ORDER BY created_at`,
    );
    return r.rows.map((x) => x.data as Fund);
  }
  async createdSince(at: number) {
    const r = await this.pool.query(
      'SELECT count(*)::int AS n FROM synq_funds WHERE created_at >= $1',
      [at],
    );
    return Number(r.rows[0]?.n ?? 0);
  }
  async launchedSince(at: number) {
    const r = await this.pool.query(
      'SELECT count(*)::int AS n FROM synq_funds WHERE launched_at >= $1',
      [at],
    );
    return Number(r.rows[0]?.n ?? 0);
  }
}
