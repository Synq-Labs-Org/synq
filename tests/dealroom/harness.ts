import { privateKeyToAccount } from 'viem/accounts';
import { keccak256, toHex, type Address, type Hex } from 'viem';
import { contract, token } from '@synq/chain-registry/arc';
import {
  MemoryNonceFence,
  mandateTypedData,
  type AuthorityConfig,
  type MandateState,
  type PaymentMandate,
} from '@synq/kernel/arc';
import {
  ChatContextService,
  MemoryChatContextStore,
  type Envelope,
} from '@synq/channels';
import { Ledger, MemoryLedgerStore } from '@synq/ledger';
import {
  DealRoomService,
  MemoryDealRoomStore,
  attestationTypedData,
  contextFromEnrolled,
  dealDecisionTypedData,
  evidenceHashOf,
  type AttestationKind,
  type AuthorizedContext,
  type DealAsset,
  type DealRoomStore,
  type DealVersion,
  type Evidence,
  type KernelInputs,
  type Party,
  type Role,
} from '@synq/dealroom';

/** Test-only keys (never funded anywhere). */
export const client = privateKeyToAccount(`0x${'c1'.repeat(32)}`);
export const freelancer = privateKeyToAccount(`0x${'f1'.repeat(32)}`);
export const arbiter = privateKeyToAccount(`0x${'a7'.repeat(32)}`);
export const mallory = privateKeyToAccount(`0x${'66'.repeat(32)}`);
export const signers = {
  CLIENT: client,
  FREELANCER: freelancer,
  ARBITER: arbiter,
} as const;

export const USDC = token('arc-testnet', 'USDC');
export const ESCROW = contract('arc-testnet', 'SYNQ_MILESTONE_ESCROW').address;
export const ASSET: DealAsset = {
  chainId: USDC.chainId,
  network: USDC.network,
  token: USDC.address,
  symbol: 'USDC',
  decimals: 6,
};
export const T0 = 1_790_000_000;
export const GROUP = '-1002024009';

export const party = (role: Role, wallet: Address, name: string): Party => ({
  role,
  displayName: name,
  principalId: `prn_${name.toLowerCase()}`,
  wallet,
  verification: {
    method: 'CHANNEL_LINK',
    reference: `lnk_${name.toLowerCase()}`,
    channel: 'telegram',
    channelUserId: String(70_000 + name.length),
    verifiedAt: T0 - 3_600,
  },
});
export const parties = {
  client: party('CLIENT', client.address, 'Dana'),
  freelancer: party('FREELANCER', freelancer.address, 'Maya'),
  arbiter: party('ARBITER', arbiter.address, 'SynqLabs'),
};

const env = (
  over: Partial<Envelope> & {
    messageId: string;
    body: string;
    timestamp: number;
    externalUserId: string;
  },
): Envelope => ({
  channel: 'telegram',
  eventId: `evt_${over.messageId}`,
  externalGroupId: GROUP,
  chatKind: 'GROUP',
  replyTo: null,
  interaction: {
    kind: 'TEXT',
    addressedToBot: false,
    command: null,
    args: '',
    callbackData: null,
  },
  attachments: [],
  verifiedSender: {
    transport: 'FIXTURE',
    providerUserId: over.externalUserId,
    displayName: null,
    isBot: false,
  },
  ...over,
});

export const CONVERSATION = [
  {
    id: '901',
    user: '7001',
    text: 'We need the Synq landing page rebuilt: hero section, pricing table and docs links.',
  },
  {
    id: '902',
    user: '7002',
    text: 'Happy to. 0.03 USDC total: 0.01 USDC when the hero section PR is merged, 0.02 USDC on final delivery of pricing and docs.',
  },
  {
    id: '903',
    user: '7001',
    text: 'Deal. Hero within 7 days, the rest within 14 days. Synq Labs arbitrates if we disagree.',
  },
];

/**
 * A chat whose memory was disclosed at T0 - 1000: one message from before
 * disclosure (never stored), then the negotiation (stored, consented).
 */
export async function enrolledChat() {
  const store = new MemoryChatContextStore();
  const svc = new ChatContextService(store);
  const p = await store.enroll({
    channel: 'telegram',
    externalGroupId: GROUP,
    groupId: 'grp_landing',
    retentionSeconds: 7 * 86_400,
    purpose: 'GROUP_FINANCIAL_PROPOSALS',
    visibility: 'ALL_MESSAGES',
    enrolledByPrincipalId: 'prn_dana',
    enrolledAt: T0 - 2_000,
  });
  await store.markDisclosed('telegram', GROUP, p.version, T0 - 1_000);
  for (const [user, principal] of [
    ['7001', 'prn_dana'],
    ['7002', 'prn_maya'],
  ] as const)
    await store.grantConsent({
      channel: 'telegram',
      externalGroupId: GROUP,
      externalUserId: user,
      principalId: principal,
      policyVersion: p.version,
      consentedAt: T0 - 900,
    });
  const principal = (u: string) => (u === '7001' ? 'prn_dana' : 'prn_maya');
  // Sent before memory was disclosed: Synq never receives it into memory.
  const old = await svc.capture({
    envelope: env({
      messageId: '800',
      externalUserId: '7002',
      body: 'Old idea: 5 USDC total for everything.',
      timestamp: T0 - 1_500,
    }),
    groupId: 'grp_landing',
    principalId: 'prn_maya',
  });
  const stored = [];
  for (const [i, m] of CONVERSATION.entries())
    stored.push(
      await svc.capture({
        envelope: env({
          messageId: m.id,
          externalUserId: m.user,
          body: m.text,
          timestamp: T0 - 600 + i * 60,
        }),
        groupId: 'grp_landing',
        principalId: principal(m.user),
      }),
    );
  const ctx = await svc.contextFor({
    channel: 'telegram',
    externalGroupId: GROUP,
    groupId: 'grp_landing',
    now: T0,
  });
  const context: AuthorizedContext = contextFromEnrolled({
    channel: 'telegram',
    externalGroupId: GROUP,
    stored: ctx,
    invocation: {
      messageId: '904',
      principalId: 'prn_dana',
      text: '/deal draft this',
      sentAt: T0 - 10,
    },
  });
  return { store, svc, old, stored, context };
}

const RUN = Math.random().toString(36).slice(2, 8);
let dealSeq = 0;

export class Clock {
  t = T0;
  now = () => this.t;
}

export function room(
  store: DealRoomStore = new MemoryDealRoomStore(),
  clock = new Clock(),
  opts: {
    evidenceVerifier?: (e: Evidence) => Promise<boolean>;
    books?: boolean;
  } = {},
) {
  const ledger = new Ledger(new MemoryLedgerStore());
  /** The executor's grant fence, shared with the service for dispute revocation. */
  const executorFence = new MemoryNonceFence();
  const service = new DealRoomService(store, {
    now: clock.now,
    chainName: 'arc-testnet',
    asset: ASSET,
    escrow: ESCROW,
    settings: {
      disputePeriodSeconds: 30 * 86_400,
      refundGraceSeconds: 7 * 86_400,
      offerTtlSeconds: 3 * 86_400,
    },
    books:
      opts.books === false
        ? null
        : { ledger, workspaceId: 'wsp_dealroom_test' },
    fence: executorFence,
    ...(opts.evidenceVerifier
      ? { evidenceVerifier: opts.evidenceVerifier }
      : {}),
    newId: () => `deal_${RUN}_${++dealSeq}`,
  });
  return { service, ledger, clock, store, executorFence };
}

export async function drafted(r = room()) {
  const { context } = await enrolledChat();
  const view = await r.service.draft({
    workspaceId: 'wsp_dealroom_test',
    context,
    request: 'draft this',
    parties,
    reasoner: null,
  });
  return { ...r, view, context };
}

export const acceptSig = (
  svc: DealRoomService,
  v: DealVersion,
  role: 'CLIENT' | 'FREELANCER',
  by = signers[role],
) => by.signTypedData(svc.typedData(v));

export const declineSig = (
  v: DealVersion,
  role: 'CLIENT' | 'FREELANCER',
  decision: 'REJECT' | 'CANCEL',
  reason: string,
  by = signers[role],
) =>
  by.signTypedData(
    dealDecisionTypedData({
      chainId: v.terms.asset.chainId,
      escrow: v.terms.escrow,
      dealId: v.dealId,
      version: v.version,
      termsHash: v.termsHash,
      role,
      decision,
      reason,
    }),
  );

export async function signedBoth(r = room()) {
  const d = await drafted(r);
  await r.service.sign({
    dealId: d.view.deal.dealId,
    version: 1,
    role: 'CLIENT',
    signature: await acceptSig(r.service, d.view.current, 'CLIENT'),
  });
  const view = await r.service.sign({
    dealId: d.view.deal.dealId,
    version: 1,
    role: 'FREELANCER',
    signature: await acceptSig(r.service, d.view.current, 'FREELANCER'),
  });
  return { ...d, view };
}

let nonceSeq = 0;
export const nonce = () =>
  `0x${(++nonceSeq).toString(16).padStart(64, '0')}` as Hex;

export async function attestation(input: {
  v: DealVersion;
  milestone: number;
  kind: AttestationKind;
  role: Role;
  evidence: Evidence | null;
  by?: (typeof signers)[Role];
  nonce?: Hex;
  deadline?: number;
}) {
  const n = input.nonce ?? nonce();
  const deadline = input.deadline ?? T0 + 86_400;
  const by = input.by ?? signers[input.role];
  const signature = await by.signTypedData(
    attestationTypedData({
      chainId: input.v.terms.asset.chainId,
      escrow: input.v.terms.escrow,
      dealId: input.v.dealId,
      version: input.v.version,
      termsHash: input.v.termsHash,
      milestone: input.milestone,
      kind: input.kind,
      role: input.role,
      evidenceHash: evidenceHashOf(input.evidence),
      nonce: n,
      deadline,
    }),
  );
  return {
    dealId: input.v.dealId,
    milestone: input.milestone,
    kind: input.kind,
    role: input.role,
    evidence: input.evidence,
    nonce: n,
    deadline,
    signature,
  };
}

export const COMMIT = 'fbe3136afb520947ec01737b6373dcc4e6a06bdb';
export const commitEvidence = (sha = COMMIT): Evidence => ({
  type: 'GITHUB_COMMIT',
  url: `https://github.com/Synq-Labs-Org/synq/commit/${sha}`,
  repo: 'Synq-Labs-Org/synq',
  commitSha: sha,
  prNumber: null,
  sha256: null,
  verifiedBy: null,
  checkedAt: T0,
});

export const GRANT_CONFIG: AuthorityConfig = {
  grantKey: new Uint8Array(32).fill(9),
  operator: 'dealroom-executor',
  grantTtlSeconds: 300,
  riskRequiredAbove: 1_000_000_000n,
};

export async function mandate(input: {
  owner: typeof client;
  id: string;
  payer: Address;
  recipients: Address[];
  purposes: PaymentMandate['purposes'];
  cap: bigint;
  budget: bigint;
}): Promise<{ mandate: PaymentMandate; signature: Hex }> {
  const m: PaymentMandate = {
    mandateId: input.id,
    version: 1,
    workspaceId: 'wsp_dealroom_test',
    owner: input.owner.address,
    chainId: USDC.chainId,
    token: USDC.address,
    payer: input.payer,
    recipients: input.recipients,
    purposes: input.purposes,
    perActionCap: input.cap,
    periodBudget: input.budget,
    periodSeconds: 30 * 86_400,
    validFrom: T0 - 60,
    validUntil: T0 + 60 * 86_400,
  };
  return {
    mandate: m,
    signature: await input.owner.signTypedData(mandateTypedData(m)),
  };
}

export function kernel(
  m: { mandate: PaymentMandate; signature: Hex },
  state: MandateState = { revoked: false, spends: [] },
): KernelInputs {
  return {
    config: GRANT_CONFIG,
    mandate: m.mandate,
    mandateSignature: m.signature,
    state,
    risk: { flags: [], available: true },
    simulationOk: true,
  };
}

export const fence = () => new MemoryNonceFence();

/** What the executor would report for a funded escrow deal (fixture; tests only). */
export function fundedRecord(v: DealVersion, escrowDealId = 7n) {
  const t = v.terms;
  const hash = keccak256(toHex(`fund:${v.dealId}`));
  return {
    execution: {
      op: 'OPEN' as const,
      milestone: null,
      escrowDealId,
      txs: [
        {
          label: 'escrow open',
          hash,
          from: t.client.wallet,
          feeWei: 4_200_000_000_000_123n,
        },
      ],
      transfers: [
        {
          from: t.client.wallet,
          to: t.escrow,
          value: t.total,
          logIndex: 1,
          hash,
        },
      ],
    },
    chain: {
      token: t.asset.token,
      payer: t.client.wallet,
      payee: t.freelancer.wallet,
      arbiter: t.arbiter.wallet,
      refundAfter: BigInt(t.refundAfter),
      termsHash: v.termsHash,
      milestones: t.milestones.map((m) => ({
        amount: m.amount,
        status: 'Funded',
      })),
    },
  };
}
