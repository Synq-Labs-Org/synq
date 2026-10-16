import type { Address } from 'viem';
import type { Vendor, VendorInvoice } from '@synq/payables';
import {
  ARC_PROVIDERS,
  buildArcWorldSnapshot,
  type ArcWorldSnapshot,
  type PendingOutcome,
  type ProviderProbe,
} from '@synq/world-model';
import {
  MemoryRiskCaseStore,
  RiskCaseService,
  unavailableScreening,
  type WalletScreeningPort,
} from '@synq/plugin-risk';
import {
  TEAM_PROVIDERS,
  TEAM_TOOL_BINDINGS,
  type TeamDesk,
} from '@synq/agent-runtime';
import {
  NOW,
  USDC,
  bob,
  cleanInvoice,
  desk as financeDesk,
  obligations,
  readers,
  sarah,
  sarahWallet,
  type WorldOver,
} from '../arc/finance-team.harness.js';

export * from '../arc/finance-team.harness.js';

/** A wallet that was never verified for Sarah (the "new wallet" in chat). */
export const newWallet = `0x${'ee'.repeat(20)}` as Address;

/** Sarah's small open invoice (the legitimate payable). */
export const smallInvoice: VendorInvoice = {
  ...cleanInvoice,
  vendorInvoiceId: 'vi_small',
  number: 'INV-0102',
  amount: 2_000_000n,
  reference: 'milestone:design-5',
  documentText:
    'Invoice INV-0102 Sarah design milestone five icon set total 2 USDC',
  dueOn: '2026-10-25',
};

export const teamObligations = [
  ...obligations,
  {
    reference: 'milestone:design-5',
    vendorId: 'sarah',
    approvedAmount: 2_000_000n,
    status: 'ACCEPTED' as const,
  },
];

export function teamProviders(
  over: Partial<Record<string, Partial<ProviderProbe>>> = {},
): ProviderProbe[] {
  return [...ARC_PROVIDERS, ...TEAM_PROVIDERS].map((p) => ({
    ...p,
    sdkInstalled: true,
    ...(p.providerId === 'ARC_RPC' || p.providerId === 'CIRCLE_GATEWAY'
      ? {
          check: async () => ({ ok: true, detail: 'ok', observedAt: NOW - 5 }),
        }
      : {}),
    ...(over[p.providerId] ?? {}),
  }));
}

export type TeamWorldOver = WorldOver & {
  pending?: PendingOutcome[];
  providers?: Partial<Record<string, Partial<ProviderProbe>>>;
  env?: Record<string, string>;
};

export function teamSnapshot(
  open: readonly VendorInvoice[],
  over: TeamWorldOver = {},
): Promise<ArcWorldSnapshot> {
  const at = over.at ?? NOW;
  return buildArcWorldSnapshot({
    readers: {
      ...readers(open, over),
      pendingOutcomes: () => ({
        value: over.pending ?? [],
        provenance: 'POSTGRES',
        source: 'payout-journal:unconfirmed',
        observedAt: at - 5,
      }),
    },
    providers: teamProviders(over.providers),
    env: over.env ?? {},
    now: at,
    tools: TEAM_TOOL_BINDINGS,
  });
}

export async function teamDesk(
  open: readonly VendorInvoice[] = [smallInvoice],
  over: Partial<TeamDesk> & TeamWorldOver = {},
): Promise<TeamDesk & { store: MemoryRiskCaseStore }> {
  const { balanceAge, balance, at, pending, providers, env, ...rest } = over;
  const world = await teamSnapshot(open, {
    ...(balanceAge === undefined ? {} : { balanceAge }),
    ...(balance === undefined ? {} : { balance }),
    ...(at === undefined ? {} : { at }),
    ...(pending ? { pending } : {}),
    ...(providers ? { providers } : {}),
    ...(env ? { env } : {}),
  });
  const base = await financeDesk(open, { world: async () => world });
  const store = new MemoryRiskCaseStore();
  const screening: WalletScreeningPort = unavailableScreening();
  return {
    ...base,
    vendors: [sarah, bob] satisfies Vendor[],
    vendorInvoices: [...base.vendorInvoices, smallInvoice],
    obligations: teamObligations,
    screening,
    cases: new RiskCaseService(store, () => NOW),
    highValueAt: 50_000_000n,
    store,
    ...rest,
  };
}

export { USDC, sarahWallet };
