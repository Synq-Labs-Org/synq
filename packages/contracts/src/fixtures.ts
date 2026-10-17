import { getAddress, keccak256, toHex } from 'viem';

/*
 * Synthetic example responses for client previews and contract tests. Every
 * value is made up: names say "Example", addresses are repeated digits and
 * hashes are derived from labels. Never ship these as real data.
 */

const at = (minutes = 0) =>
  new Date(Date.UTC(2026, 9, 17, 10, minutes, 0)).toISOString();
const address = (digit: string) => getAddress(`0x${digit.repeat(40)}`);
const hint = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const hash = (label: string) => keccak256(toHex(`synq-fixture:${label}`));
const uuid = (n: number) =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

const usdc = {
  assetId: 'arc-testnet:USDC',
  symbol: 'USDC',
  chainId: 5042002,
  decimals: 6,
};
const money = (units: string) => ({ ...usdc, units });
const balance = (settled: string, reserved = '0', pending = '0') => ({
  ...usdc,
  settled,
  reserved,
  pending,
  quarantined: '0',
});
const fresh = { observedAt: at(), source: 'CHAIN' as const, stale: false };

const me = address('1');
const vault = address('2');
const vendor = address('3');
const business = uuid(1);
const circle = uuid(2);
const lead = uuid(3);
const run = uuid(4);
const offer = uuid(5);
const request = uuid(6);

const runSummary = {
  runId: run,
  workspaceId: business,
  title: 'Pay the design contractor after the client deposit',
  trigger: 'DEPOSIT_FINALIZED' as const,
  status: 'RECONCILED' as const,
  amount: money('40000000'),
  proofLevel: 'LOCAL_FIXTURE' as const,
  startedAt: at(1),
  updatedAt: at(4),
};

const leadSummary = {
  leadId: lead,
  workspaceId: business,
  label: 'Telegram lead · 4F2A',
  source: 'TELEGRAM' as const,
  stage: 'NEGOTIATING' as const,
  handling: 'AGENT' as const,
  needsOwner: false,
  unread: 2,
  lastActivityAt: at(3),
};

const approvalItem = {
  requestId: request,
  workspaceId: business,
  workspaceName: 'Example Studio',
  purpose: 'PAYOUT' as const,
  summary: 'Pay 40 USDC to an allowlisted contractor',
  amount: money('40000000'),
  recipientHint: hint(vendor),
  approvals: 1,
  threshold: 2,
  expiresAt: at(60),
};

export const FIXTURES: Readonly<Record<string, unknown>> = {
  Meta: {
    contractVersion: '3.0.0',
    routes: [
      { id: 'me.contexts', status: 'IMPLEMENTED' },
      { id: 'workspace.inbox', status: 'PLANNED' },
    ],
  },
  DeviceSession: {
    principalId: 'principal-example',
    sessionId: uuid(10),
    accessToken: '0'.repeat(64).replace(/^0/, 'a'),
    accessExpiresAt: at(15),
    refreshToken: '0'.repeat(64).replace(/^0/, 'b'),
    refreshExpiresAt: at(60 * 24 * 7),
  },
  Contexts: {
    principalId: 'principal-example',
    walletHint: hint(me),
    contexts: [
      {
        contextId: 'personal',
        kind: 'PERSONAL',
        workspaceId: null,
        displayName: 'Personal',
        role: null,
        workspaceStatus: null,
        unreadCount: 1,
      },
      {
        contextId: business,
        kind: 'BUSINESS',
        workspaceId: business,
        displayName: 'Example Studio',
        role: 'OWNER',
        workspaceStatus: 'ACTIVE',
        unreadCount: 3,
      },
    ],
  },
  PersonalOverview: {
    principalId: 'principal-example',
    wallets: [
      {
        address: me,
        label: 'Sign-in wallet',
        balances: [balance('12500000')],
        freshness: fresh,
      },
    ],
    circles: [
      {
        circleId: circle,
        displayName: 'Example trip circle',
        status: 'ACTIVE',
        role: 'MEMBER',
        memberCount: 3,
        threshold: 2,
        vault,
        myContribution: money('5000000'),
        held: balance('15000000', '5000000'),
        openProposals: 1,
        freshness: fresh,
      },
    ],
    vaults: [],
    recent: [
      {
        activityId: 'activity-1',
        kind: 'CONTRIBUTION',
        title: 'You added 5 USDC to Example trip circle',
        workspaceId: circle,
        amount: money('5000000'),
        status: 'FINAL',
        txHash: hash('contribution'),
        occurredAt: at(2),
      },
    ],
  },
  WorkspaceOverview: {
    workspaceId: business,
    displayName: 'Example Studio',
    status: 'ACTIVE',
    role: 'OWNER',
    balances: [balance('250000000', '40000000', '10000000')],
    receivables: { open: 2, units: '120000000' },
    payables: { open: 1, units: '40000000' },
    leads: { open: 4, needsOwner: 1 },
    pendingApprovals: 1,
    agentHighlights: [runSummary],
    capabilities: {
      leads: { status: 'AVAILABLE', reason: 'Private Telegram sessions.' },
      agentLeases: {
        status: 'NOT_CONFIGURED',
        reason: 'No Amane lease is installed for this workspace.',
      },
    },
    freshness: fresh,
  },
  InboxPage: { items: [leadSummary], nextCursor: null },
  LeadDetail: {
    lead: leadSummary,
    handlingVersion: 3,
    consent: {
      granted: true,
      grantedAt: at(1),
      scope: 'The business may read this private conversation.',
    },
    messages: [
      {
        messageId: uuid(20),
        author: 'LEAD',
        text: 'Can you do a logo and two banners by Friday?',
        offerVersion: null,
        createdAt: at(2),
      },
      {
        messageId: uuid(21),
        author: 'AGENT',
        text: 'Yes. Here is an offer for 120 USDC in two milestones.',
        offerVersion: 1,
        createdAt: at(3),
      },
    ],
    olderMessagesCursor: null,
    offers: [
      {
        offerId: offer,
        version: 1,
        termsHash: hash('offer-1'),
        previousTermsHash: null,
        policyVersion: 2,
        status: 'SENT',
        createdBy: 'AGENT',
        total: money('120000000'),
        lines: [
          {
            description: 'Logo and two banners',
            quantity: 1,
            unitUnits: '120000000',
            totalUnits: '120000000',
          },
        ],
        milestones: [
          { label: 'Drafts', units: '60000000', dueAt: at(60 * 48) },
          { label: 'Final files', units: '60000000', dueAt: at(60 * 96) },
        ],
        expiresAt: at(60 * 24),
        createdAt: at(3),
      },
    ],
  },
  AgentRunDetail: {
    run: runSummary,
    events: [
      {
        eventId: uuid(30),
        workspaceId: business,
        runId: run,
        sequence: '1',
        correlationId: 'corr-example',
        causationId: null,
        kind: 'DECISION',
        actor: 'MODEL',
        status: 'PENDING',
        summary: 'Proposed paying the contractor 40 USDC from the deposit.',
        sourceKind: 'CFO_AGENT',
        observedAt: at(1),
        effectiveAt: null,
        evidenceHash: null,
        proofLevel: 'NOT_VERIFIED',
        amount: money('40000000'),
        recipientHint: hint(vendor),
        txHash: null,
        chainId: null,
      },
      {
        eventId: uuid(31),
        workspaceId: business,
        runId: run,
        sequence: '2',
        correlationId: 'corr-example',
        causationId: uuid(30),
        kind: 'GRANT',
        actor: 'DETERMINISTIC',
        status: 'AUTHORIZED',
        summary: 'Kernel allowed one payment within the lease.',
        sourceKind: 'KERNEL',
        observedAt: at(2),
        effectiveAt: at(2),
        evidenceHash: hash('grant'),
        proofLevel: 'LOCAL_FIXTURE',
        amount: money('40000000'),
        recipientHint: hint(vendor),
        txHash: null,
        chainId: null,
      },
    ],
    receipts: [
      {
        chainId: 5042002,
        txHash: hash('payment'),
        blockNumber: '1000',
        finality: 'FINALIZED',
        explorerUrl: null,
        ledgerEntryId: 'ledger-example',
      },
    ],
  },
  Mandates: {
    capability: {
      status: 'NOT_CONFIGURED',
      reason: 'No Amane lease is installed for this workspace.',
    },
    leases: [],
  },
  ApprovalPage: { items: [approvalItem], nextCursor: null },
  SigningRequest: {
    request: approvalItem,
    signer: hint(me),
    enforcedBy: 'Workspace Safe and its policy guard',
    typedData: {
      domain: { name: 'Example', version: '1', chainId: 5042002 },
      types: { Example: [{ name: 'amount', type: 'uint256' }] },
      primaryType: 'Example',
      message: { amount: '40000000' },
    },
  },
  NotificationPage: {
    items: [
      {
        notificationId: uuid(40),
        eventId: uuid(41),
        category: 'NEW_LEAD',
        workspaceId: business,
        title: 'New enquiry',
        deepLink: `/w/${business}/inbox/${lead}`,
        createdAt: at(3),
        readAt: null,
      },
    ],
    nextCursor: null,
    unreadCount: 1,
  },
};
