import { createHash, randomBytes } from 'node:crypto';
import {
  createPublicClient,
  erc20Abi,
  getAddress,
  http,
  isAddress,
  isAddressEqual,
  parseAbi,
  type Address,
  type PublicClient,
} from 'viem';
import { CHAINS, contract, token } from '@synq/chain-registry/arc';
import { moneyFromDecimal } from '@synq/domain';
import {
  TEAM_PROVIDERS,
  TEAM_TOOL_BINDINGS,
  askTeam,
  teamCard,
  teamReplyView,
  type StructuredReasoner,
  type TeamDesk,
} from '@synq/agent-runtime';
import {
  computeWaterfall,
  explainAllocation,
  forecastCash,
  policyHash,
  units,
  type CashPosition,
  type RevenuePolicy,
  type SplitRecord,
} from '@synq/allocations';
import {
  contextFromGuestQuery,
  dealLinkToken,
  decimalOf,
  DealRoomError,
  DEAL_LINK_TTL_SECONDS,
  type DealRoomService,
  type Party,
} from '@synq/dealroom';
import {
  InvoiceError,
  draftInvoice,
  invoiceCard,
  type Invoice,
  type InvoiceService,
} from '@synq/invoices';
import type { Vendor } from '@synq/payables';
import { registeredVaults } from '@synq/plugin-circle-earn';
import {
  MemoryRiskCaseStore,
  RiskCaseService,
  unavailableScreening,
} from '@synq/plugin-risk';
import { checkUsycEntitlement, type UsycReader } from '@synq/plugin-usyc';
import {
  ARC_PROVIDERS,
  buildArcWorldSnapshot,
  type ProviderProbe,
} from '@synq/world-model';
import {
  ISSUE_LINK_TTL_SECONDS,
  issueLinkToken,
  payPathFor,
} from '@synq/api/invoice-routes';

/**
 * The Arc business desk behind the Messages app's business features: Deal
 * Room drafts, invoices, the agent-team council, treasury, revenue-split
 * previews and verified contractors, all on Arc testnet.
 *
 * Nothing here holds a key or moves money. Reads come from Arc (balances,
 * the governed vault's Safe owners, its recipient allowlist and caps, Earn
 * vaults, USYC entitlements); drafts (deals, invoices) are signed by the
 * parties in their own wallets on the Synq pages; the council runs without
 * a Kernel, so it can recommend but never submit a payment.
 */

export const ARC = CHAINS['arc-testnet'];
const USDC = token('arc-testnet', 'USDC');

export class BusinessError extends Error {
  constructor(
    readonly code:
      | 'NOT_ENABLED'
      | 'NOT_FOUND'
      | 'BAD_AMOUNT'
      | 'ARC_UNAVAILABLE'
      | 'RATE_LIMITED',
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'BusinessError';
  }
}

/** A contractor named in config; it is payable only while the vault allowlists it. */
export type ArcVendorConfig = Readonly<{
  vendorId: string;
  name: string;
  address: Address;
  /** Unix seconds the address was verified (cooling is measured from it). */
  verifiedAt: number;
}>;

/** `Name:0xAddress[:verifiedAtUnix]` entries separated by commas. */
export function parseVendors(raw: string | undefined): ArcVendorConfig[] {
  const out: ArcVendorConfig[] = [];
  for (const entry of (raw ?? '').split(',')) {
    const [name, address, at] = entry.split(':').map((s) => s.trim());
    if (!name || !address || !isAddress(address)) continue;
    const vendorId = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40);
    if (!vendorId || out.some((v) => v.vendorId === vendorId)) continue;
    out.push({
      vendorId,
      name: name.slice(0, 60),
      address: getAddress(address),
      verifiedAt: at && /^\d{9,11}$/.test(at) ? Number(at) : 0,
    });
  }
  return out.slice(0, 20);
}

/** Read-only Arc access; tests pass fakes. */
export type ArcReads = Readonly<{
  blockNumber(): Promise<bigint>;
  usdc(account: Address): Promise<bigint>;
  isRecipient(account: Address): Promise<boolean>;
  safeOwners(): Promise<Address[]>;
  vaultPolicy(): Promise<{
    perPaymentCap: bigint;
    windowCap: bigint;
    remaining: bigint;
    paused: boolean;
  }>;
  earnVaults(): Promise<
    {
      name: string;
      address: Address;
      underlyingOk: boolean;
      totalAssets: bigint | null;
    }[]
  >;
  usyc(
    wallet: Address,
    now: number,
  ): Promise<{
    status: 'ELIGIBLE' | 'INELIGIBLE' | 'UNAVAILABLE';
    explanation: string;
  }>;
}>;

export const VAULT = {
  safe: contract('arc-testnet', 'SYNQ_ARC_VAULT_SAFE').address as Address,
  policy: contract('arc-testnet', 'SYNQ_ARC_VAULT_POLICY').address as Address,
};

const POLICY_ABI = parseAbi([
  'function isRecipient(address) view returns (bool)',
  'function perPaymentCap() view returns (uint256)',
  'function windowCap() view returns (uint256)',
  'function windowSpent() view returns (uint256)',
  'function windowStart() view returns (uint64)',
  'function paused() view returns (bool)',
]);
const SAFE_ABI = parseAbi(['function getOwners() view returns (address[])']);
const VAULT_4626_ABI = parseAbi([
  'function asset() view returns (address)',
  'function totalAssets() view returns (uint256)',
]);

export function liveArcReads(rpcUrl?: string): ArcReads {
  const client = createPublicClient({
    transport: http(rpcUrl ?? ARC.rpcUrls[0], {
      retryCount: 2,
      retryDelay: 300,
      timeout: 10_000,
    }),
  }) as PublicClient;
  const policy = <T>(functionName: string, args: readonly unknown[] = []) =>
    client.readContract({
      address: VAULT.policy,
      abi: POLICY_ABI,
      functionName: functionName as 'paused',
      args: args as [],
    }) as Promise<T>;
  return {
    blockNumber: () => client.getBlockNumber(),
    usdc: (account) =>
      client.readContract({
        address: USDC.address as Address,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [account],
      }),
    isRecipient: (account) => policy<boolean>('isRecipient', [account]),
    safeOwners: async () =>
      (await client.readContract({
        address: VAULT.safe,
        abi: SAFE_ABI,
        functionName: 'getOwners',
      })) as Address[],
    vaultPolicy: async () => {
      const [perPaymentCap, windowCap, spent, start, paused, block] =
        await Promise.all([
          policy<bigint>('perPaymentCap'),
          policy<bigint>('windowCap'),
          policy<bigint>('windowSpent'),
          policy<bigint>('windowStart'),
          policy<boolean>('paused'),
          client.getBlock(),
        ]);
      const used = block.timestamp >= start + 86_400n ? 0n : spent;
      return {
        perPaymentCap,
        windowCap,
        remaining: windowCap > used ? windowCap - used : 0n,
        paused,
      };
    },
    earnVaults: () =>
      Promise.all(
        registeredVaults().map(async (v) => {
          const [asset, total] = await Promise.all([
            client
              .readContract({
                address: v.address,
                abi: VAULT_4626_ABI,
                functionName: 'asset',
              })
              .catch(() => null),
            client
              .readContract({
                address: v.address,
                abi: VAULT_4626_ABI,
                functionName: 'totalAssets',
              })
              .catch(() => null),
          ]);
          return {
            name:
              v.kind === 'CIRCLE_EARN_VAULT_USDC'
                ? 'Circle Earn USDC vault'
                : 'Circle Earn test vault (mock Morpho)',
            address: v.address as Address,
            underlyingOk:
              asset !== null &&
              isAddressEqual(asset as Address, USDC.address as Address),
            totalAssets: total as bigint | null,
          };
        }),
      ),
    usyc: async (wallet, now) => {
      try {
        const e = await checkUsycEntitlement(
          client as unknown as UsycReader,
          wallet,
          'deposit',
          now,
        );
        return { status: e.status, explanation: e.explanation };
      } catch (error) {
        return {
          status: 'UNAVAILABLE',
          explanation: `USYC eligibility could not be checked: ${(error as Error).message.slice(0, 160)}`,
        };
      }
    },
  };
}

const usdcText = (units6: bigint) => units(units6, USDC.decimals);
const addressUrl = (a: string) => `${ARC.explorer}/address/${a}`;
const NETWORK = {
  network: 'Arc testnet',
  chainId: ARC.chainId,
} as const;

/** Decimal USDC text → base units; refuses more than 6 places, zero, or above `max`. */
export function usdcUnits(text: string, max = 10_000n * 1_000_000n): bigint {
  if (!/^\d{1,7}(\.\d{1,6})?$/.test(text.trim()))
    throw new BusinessError('BAD_AMOUNT', 400, 'Enter an amount in USDC.');
  const v = moneyFromDecimal(USDC, text.trim()).baseUnits;
  if (v <= 0n || v > max)
    throw new BusinessError(
      'BAD_AMOUNT',
      400,
      `Amounts must be above 0 and at most ${usdcText(max)} USDC.`,
    );
  return v;
}

export type ArcBusinessDeps = Readonly<{
  name: string;
  reads: ArcReads;
  vendors: readonly ArcVendorConfig[];
  /** The business owner wallet; must be an owner of the vault Safe. */
  owner?: Address;
  now: () => number;
  webBaseUrl: string;
  reasoner: StructuredReasoner | null;
  /** Only presence is read (provider awareness); values are never copied. */
  env: Readonly<Record<string, string | undefined>>;
  deals?: Readonly<{ service: DealRoomService; linkKey: Uint8Array }>;
  invoices?: Readonly<{ service: InvoiceService; payLinkKey: Uint8Array }>;
  /** Defaults to an in-memory store: the council's audit stays in this process. */
  cases?: RiskCaseService;
  /** Why Deal Room or invoices are off when their key is set but startup failed. */
  offReasons?: Readonly<{ deals?: string; invoices?: string }>;
  /** Cash the vault keeps unreserved (base units); default 0.02 USDC, testnet scale. */
  operatingFloor?: bigint;
}>;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export class ArcBusiness {
  readonly workspaceId = 'wsp_arc_business';
  private readonly cases: RiskCaseService;
  private vendorCache: { at: number; vendors: Vendor[] } | null = null;
  private readonly floor: bigint;

  constructor(readonly deps: ArcBusinessDeps) {
    this.cases =
      deps.cases ?? new RiskCaseService(new MemoryRiskCaseStore(), deps.now);
    this.floor = deps.operatingFloor ?? 20_000n;
  }

  private get web() {
    return this.deps.webBaseUrl.replace(/\/$/, '');
  }

  /** Arc reads fail as one honest error, never as a guess. */
  private async arc<T>(read: () => Promise<T>): Promise<T> {
    try {
      return await read();
    } catch (error) {
      if (error instanceof BusinessError) throw error;
      throw new BusinessError(
        'ARC_UNAVAILABLE',
        502,
        'Arc testnet is not reachable right now. Try again in a moment.',
      );
    }
  }

  capabilities() {
    const on = { enabled: true, reason: null };
    return {
      ...NETWORK,
      business: this.deps.name,
      features: {
        deals: this.deps.deals
          ? on
          : {
              enabled: false,
              reason:
                this.deps.offReasons?.deals ??
                'Deal Room needs SYNQ_DEALROOM_LINK_KEY on this server.',
            },
        invoices: this.deps.invoices
          ? on
          : {
              enabled: false,
              reason:
                this.deps.offReasons?.invoices ??
                'Invoices need SYNQ_PAY_LINK_KEY on this server.',
            },
        team: on,
        treasury: on,
        splits: on,
        contractors: this.deps.vendors.length
          ? on
          : {
              enabled: false,
              reason: 'No contractors are configured (SYNQ_ARC_VENDORS).',
            },
      },
    };
  }

  /** The configured owner, or the first owner of the vault Safe; checked on chain. */
  private async owner(): Promise<{ owner: Address; owners: Address[] }> {
    const owners = await this.arc(() => this.deps.reads.safeOwners());
    const owner = this.deps.owner ?? owners[0];
    if (!owner || !owners.some((o) => isAddressEqual(o, owner)))
      throw new BusinessError(
        'NOT_ENABLED',
        503,
        'The business owner is not an owner of the Arc vault.',
      );
    return { owner, owners };
  }

  /** Config names; VERIFIED only while the vault policy allowlists the address. */
  async vendorMaster(): Promise<Vendor[]> {
    const now = this.deps.now();
    if (this.vendorCache && now - this.vendorCache.at < 60)
      return this.vendorCache.vendors;
    const allowed = await this.arc(() =>
      Promise.all(
        this.deps.vendors.map((v) => this.deps.reads.isRecipient(v.address)),
      ),
    );
    const vendors: Vendor[] = this.deps.vendors.map((v, i) => ({
      vendorId: v.vendorId,
      workspaceId: this.workspaceId,
      name: v.name,
      kind: 'CONTRACTOR',
      addresses: [
        {
          chainId: ARC.chainId,
          address: v.address,
          status: allowed[i] ? 'VERIFIED' : 'PENDING',
          source: allowed[i]
            ? 'vault allowlist (isRecipient=true)'
            : 'not on the vault allowlist',
          at: v.verifiedAt,
          verifiedBy: allowed[i] ? 'vault governance' : null,
        },
      ],
    }));
    this.vendorCache = { at: now, vendors };
    return vendors;
  }

  async vendors() {
    const master = await this.vendorMaster();
    return {
      ...NETWORK,
      vendors: master.map((v) => ({
        vendorId: v.vendorId,
        name: v.name,
        kind: v.kind,
        address: v.addresses[0]!.address,
        verified: v.addresses[0]!.status === 'VERIFIED',
        source: v.addresses[0]!.source,
      })),
    };
  }

  async treasury() {
    const now = this.deps.now();
    const { owner } = await this.owner();
    const [block, vault, own, policy, earn, usyc] = await this.arc(() =>
      Promise.all([
        this.deps.reads.blockNumber(),
        this.deps.reads.usdc(VAULT.safe),
        this.deps.reads.usdc(owner),
        this.deps.reads.vaultPolicy().catch(() => null),
        this.deps.reads.earnVaults().catch(() => []),
        this.deps.reads.usyc(VAULT.safe, now),
      ]),
    );
    return {
      ...NETWORK,
      mode: 'LIVE_ARC_TESTNET',
      blockNumber: String(block),
      observedAt: now,
      accounts: [
        {
          label: 'Governed vault',
          address: VAULT.safe,
          usdc: usdcText(vault),
          explorer: addressUrl(VAULT.safe),
        },
        {
          label: 'Owner',
          address: owner,
          usdc: usdcText(own),
          explorer: addressUrl(owner),
        },
      ],
      vaultPolicy: policy && {
        perPaymentCap: usdcText(policy.perPaymentCap),
        windowCap: usdcText(policy.windowCap),
        remaining: usdcText(policy.remaining),
        paused: policy.paused,
      },
      earn: earn.map((e) => ({
        name: e.name,
        address: e.address,
        underlyingOk: e.underlyingOk,
        totalAssets: e.totalAssets === null ? null : usdcText(e.totalAssets),
        apy: null,
        note: 'Testnet vault. APY comes from Circle App Kit and is not fetched here; it is variable, never guaranteed.',
      })),
      usyc: { wallet: VAULT.safe, ...usyc },
    };
  }

  /** The demo revenue policy: 25% tax estimate, the configured floor, 30-day horizon. */
  private policy(owner: Address, vendors: readonly Vendor[]): RevenuePolicy {
    const now = this.deps.now();
    return {
      policyId: 'preview_default',
      version: 1,
      workspaceId: this.workspaceId,
      owner,
      chainId: ARC.chainId,
      token: getAddress(USDC.address),
      decimals: USDC.decimals,
      treasury: VAULT.safe,
      validFrom: now - 60,
      validUntil: now + 3_600,
      taxReserveBps: 2_500,
      operatingFloor: this.floor,
      obligationHorizonDays: 30,
      allowedBeneficiaries: vendors
        .filter((v) => v.addresses[0]?.status === 'VERIFIED')
        .map((v) => ({
          beneficiaryId: v.vendorId,
          address: v.addresses[0]!.address,
          label: v.name.slice(0, 80),
        })),
      distributions: [],
      limits: {
        maxAutonomousPerLeg: 5_000n,
        maxAutonomousPerWindow: 5_000n,
        windowSeconds: 86_400,
        maxSplitsPerWindow: 10,
      },
      maxBalanceAgeSeconds: 300,
      remainder: 'FREE_CASH',
      cancellation: 'BEFORE_EXECUTION',
      recovery: 'RECONCILE_THEN_REVIEW',
    };
  }

  /**
   * What the waterfall would do if `amount` arrived in the vault now. Pure
   * computation over the live vault balance; nothing is reserved or sent.
   */
  async splitPreview(amountText: string) {
    const amount = usdcUnits(amountText);
    const now = this.deps.now();
    const { owner } = await this.owner();
    const [block, balance, vendors] = await this.arc(() =>
      Promise.all([
        this.deps.reads.blockNumber(),
        this.deps.reads.usdc(VAULT.safe),
        this.vendorMaster(),
      ]),
    );
    const policy = this.policy(owner, vendors);
    const receiptId = `preview:${ARC.chainId}:${block}`;
    const position: CashPosition = {
      treasury: VAULT.safe,
      onChainFinalized: balance + amount,
      observedBlock: block,
      observedAt: now,
      source: 'rpc:arc-testnet:usdc.balanceOf(vault) + preview amount',
      reservations: 0n,
      committedOutgoing: 0n,
      escrowLiabilities: 0n,
      refundLiabilities: 0n,
      invested: 0n,
    };
    const receipt = {
      receiptId,
      chainId: ARC.chainId,
      token: policy.token,
      txHash: `0x${'00'.repeat(32)}` as const,
      logIndex: 0,
      blockNumber: block,
      amount,
      recipient: VAULT.safe,
      payer: VAULT.safe,
      invoiceId: 'preview',
      invoiceNumber: 'PREVIEW',
      source: 'MEMO_INVOICE' as const,
      // Computation only: the waterfall plans from final receipts.
      finality: 'FINAL' as const,
    };
    const plan = computeWaterfall({
      policy,
      policyHash: policyHash(policy),
      receipt,
      position,
      asOf: now,
      vendors,
      payables: [],
      payableHistory: [],
      obligations: [],
      bills: [],
      receivables: [],
    });
    const split: SplitRecord = {
      splitId: 'preview',
      workspaceId: this.workspaceId,
      receiptId,
      invoiceId: 'preview',
      policyId: policy.policyId,
      policyVersion: policy.version,
      state: 'POLICY_VALIDATED',
      rev: 0,
      receipt,
      plan,
      note: 'preview',
      createdAt: now,
      updatedAt: now,
    };
    const explained = explainAllocation({
      split,
      legs: [],
      reservations: [],
      decimals: USDC.decimals,
      symbol: 'USDC',
      explorer: ARC.explorer,
    });
    const LABEL: Record<string, string> = {
      TAX_ESTIMATE: 'Tax reserve',
      CONTRACTOR_PAYABLE: 'Contractor payables',
      PAYABLE_HELD: 'Payables held',
      UPCOMING_BILL: 'Upcoming bills',
      OPERATING_FLOOR: 'Operating floor',
      DISTRIBUTION: 'Distributions',
      UNALLOCATED: 'Free cash',
    };
    const forecast = forecastCash({
      asOf: now,
      position: { ...position, onChainFinalized: balance },
      heldForTax: 0n,
      payables: [],
      bills: [],
      receivables: [],
      scenario: 'BASE',
    });
    return {
      ...NETWORK,
      mode: 'PREVIEW',
      label: 'PREVIEW',
      amount: usdcText(amount),
      symbol: 'USDC',
      headline: `Preview: if ${usdcText(amount)} USDC arrived in the vault now, ${explained.headline
        .replace(/^[^:]*: /, '')
        .replace(/ \([A-Z_]+\)\.$/, '.')}`,
      legs: plan.legs.map((l) => ({
        purpose: l.purpose,
        kind: l.kind,
        label: LABEL[l.purpose] ?? l.purpose,
        amount: usdcText(l.amount),
        basis: l.basis,
      })),
      summary: Object.fromEntries(
        Object.entries(explained.summary).filter(([k]) => k !== 'state'),
      ),
      forecast: forecast.points.map((p) => ({
        days: p.days,
        committed: usdcText(p.committedCash),
        expected: usdcText(p.expectedCash),
        lowPoint: usdcText(p.lowPoint),
      })),
      policy: {
        taxReserveBps: policy.taxReserveBps,
        operatingFloor: usdcText(policy.operatingFloor),
        horizonDays: policy.obligationHorizonDays,
      },
      notes: [
        'Preview only: nothing is reserved or sent.',
        `Starts from the vault's live balance (${usdcText(balance)} USDC at block ${block}). No payables or bills are booked for this business on this server.`,
        'The tax line is an estimate held back, never a tax payment.',
      ],
    };
  }

  private async desk(): Promise<TeamDesk> {
    const at = this.deps.now();
    const { owner, owners } = await this.owner();
    const [block, vaultUsdc, ownerUsdc, vendors] = await this.arc(() =>
      Promise.all([
        this.deps.reads.blockNumber(),
        this.deps.reads.usdc(VAULT.safe),
        this.deps.reads.usdc(owner),
        this.vendorMaster(),
      ]),
    );
    const r =
      <T>(
        value: T,
        provenance: 'CHAIN' | 'CONFIG' | 'KERNEL',
        source: string,
      ) =>
      () => ({ value, provenance, source, observedAt: at });
    // Only Arc RPC runs in this process; every other provider reports unavailable.
    const providers: ProviderProbe[] = [
      ...ARC_PROVIDERS,
      ...TEAM_PROVIDERS,
    ].map((p) => ({
      ...p,
      sdkInstalled: p.providerId === 'ARC_RPC',
      ...(p.providerId === 'ARC_RPC'
        ? {
            check: async () => ({
              ok: true,
              detail: `arc-testnet block ${block}`,
              observedAt: at,
            }),
          }
        : {}),
    }));
    const invoices = this.deps.invoices
      ? (await this.deps.invoices.service.store.list(this.workspaceId)).map(
          (s) => s.invoice,
        )
      : [];
    const world = await buildArcWorldSnapshot({
      now: at,
      env: this.deps.env,
      providers,
      tools: TEAM_TOOL_BINDINGS,
      readers: {
        user: r(
          { principalId: 'arc-business-owner', displayName: 'Owner' },
          'CONFIG',
          'server:arc-business',
        ),
        workspace: r(
          {
            workspaceId: this.workspaceId,
            name: this.deps.name,
            kind: 'BUSINESS' as const,
          },
          'CONFIG',
          'server:arc-business',
        ),
        memberships: r(
          owners.map((o) => ({
            principalId: isAddressEqual(o, owner)
              ? 'arc-business-owner'
              : `safe-owner:${o.toLowerCase()}`,
            displayName: isAddressEqual(o, owner)
              ? 'Owner'
              : `Vault co-owner ${o.slice(0, 6)}…${o.slice(-4)}`,
            role: isAddressEqual(o, owner)
              ? ('OWNER' as const)
              : ('APPROVER' as const),
            verified: true,
            via: 'vault Safe getOwners() on Arc testnet',
          })),
          'CHAIN',
          'rpc:arc-testnet:safe.getOwners',
        ),
        wallets: r(
          [
            {
              address: owner,
              chain: 'arc-testnet' as const,
              ownerPrincipalId: 'arc-business-owner',
              kind: 'OWNER_EOA' as const,
              role: 'PAYOUT' as const,
              verifiedBy: 'vault Safe owner',
            },
            {
              address: VAULT.safe,
              chain: 'arc-testnet' as const,
              ownerPrincipalId: 'arc-business-owner',
              kind: 'SAFE_VAULT' as const,
              role: 'TREASURY' as const,
              verifiedBy: 'registry SYNQ_ARC_VAULT_SAFE',
            },
          ],
          'CONFIG',
          'sources/arc_registry.json',
        ),
        balances: r(
          [
            {
              chain: 'arc-testnet' as const,
              account: VAULT.safe,
              asset: 'USDC' as const,
              baseUnits: String(vaultUsdc),
            },
            {
              chain: 'arc-testnet' as const,
              account: owner,
              asset: 'USDC' as const,
              baseUnits: String(ownerUsdc),
            },
          ],
          'CHAIN',
          `rpc:arc-testnet:usdc.balanceOf@${block}`,
        ),
        reserves: r(
          {
            minimumReserve: String(this.floor),
            reservations: '0',
            escrow: '0',
          },
          'CONFIG',
          'server:preview-policy',
        ),
        receivables: r(
          invoices
            .filter(
              (i) => i.status === 'ISSUED' || i.status === 'PARTIALLY_PAID',
            )
            .map((i) => ({
              invoiceId: i.invoiceId,
              number: i.number,
              payer: i.payer.name,
              total: String(i.total),
              amountDue: String(i.total - i.paid - i.credited),
              dueDate: i.dueDate,
              status: i.status,
            })),
          'CONFIG',
          'server:invoices',
        ),
        payables: r([], 'CONFIG', 'server:no AP booked'),
        mandates: r([], 'KERNEL', 'server:no payout mandate'),
        pendingApprovals: r([], 'KERNEL', 'server:no approvals'),
        workflows: r([], 'KERNEL', 'server:no workflows'),
        blockers: r(
          [
            {
              code: 'PAYOUT_MANDATE_NOT_CONFIGURED',
              detail:
                'this server runs the council read-only: no Kernel or payout mandate is connected',
              ref: 'reports/phases/P22-HOME-ARC-FEATURES.md',
            },
          ],
          'CONFIG',
          'server:arc-business',
        ),
        pendingOutcomes: r([], 'KERNEL', 'server:no payouts'),
      },
    });
    return {
      workspaceId: this.workspaceId,
      world: async () => world,
      vendors,
      vendorProvenance: 'CONFIG + vault allowlist',
      vendorInvoices: [],
      obligations: [],
      invoices,
      evidence: [],
      ...(this.deps.reasoner ? { reasoner: this.deps.reasoner } : {}),
      today: new Date(at * 1000).toISOString().slice(0, 10),
      now: at,
      clock: this.deps.now,
      screening: unavailableScreening(),
      cases: this.cases,
      highValueAt: 50_000_000n,
      destinationCoolingSeconds: 24 * 3_600,
      explorerTxUrl: `${ARC.explorer}/tx/`,
    };
  }

  /** One council turn, read-only: no Kernel is attached, so nothing can be submitted. */
  async teamAsk(text: string, fundId: string) {
    const runId = `team_${randomBytes(6).toString('hex')}`;
    const reply = await askTeam(text, await this.desk(), {
      runId,
      origin: 'CHAT',
    });
    const view = teamReplyView(reply);
    const decision = reply.sections.find((s) => s.persona === 'DECISION');
    const card = teamCard(reply, {
      groupId: fundId,
      groupLabel: this.deps.name,
      executionMode: 'LIVE_ARC_TESTNET',
      issuedAt: this.deps.now(),
      question: text,
      chainId: ARC.chainId,
    });
    return {
      ...NETWORK,
      mode: 'LIVE_ARC_TESTNET',
      readOnly: true,
      status: reply.status,
      runId: reply.runId,
      sections: reply.sections
        .filter((s) => s.persona !== 'DECISION')
        .map((s) => ({
          persona: s.persona,
          label: s.label,
          stance: s.stance,
          text: s.text,
          evidence:
            view.sections.find((v) => v.label === s.label)?.evidence ?? [],
        })),
      decision: {
        status: reply.decision.status,
        outcome: reply.decision.outcome,
        reasons: reply.decision.reasons,
        text: decision?.text ?? null,
      },
      riskCase: reply.riskCase,
      unavailable: view.unavailable,
      approvalUrl: view.approval
        ? `${this.web}${view.approval.reviewPath}`
        : null,
      answer: reply.answer,
      card,
    };
  }

  /** Drafts terms from the member's text; both parties sign on the Deal Room page. */
  async draftDeal(text: string, fundId: string) {
    const deals = this.deps.deals;
    if (!deals)
      throw new BusinessError(
        'NOT_ENABLED',
        503,
        'Deal Room is not enabled on this server yet.',
      );
    const refuse = (reason: string) => ({
      ...NETWORK,
      status: 'REFUSED' as const,
      reason,
    });
    const now = this.deps.now();
    const { owner, owners } = await this.owner();
    const master = await this.vendorMaster();
    const verified = master.filter(
      (v) => v.addresses[0]?.status === 'VERIFIED',
    );
    // The contractor must be named; an unverified or unknown name is never swapped for another.
    const named = master.filter((v) => {
      const word = v.name.split(/\s+/)[0]!.replace(/[^A-Za-z0-9]/g, '');
      return word.length > 0 && new RegExp(`\\b${word}\\b`, 'i').test(text);
    });
    const list = verified.map((v) => v.name).join(', ');
    if (named.length !== 1)
      return refuse(
        verified.length
          ? `Name one verified contractor: ${list}.`
          : 'No verified contractor is on the vault allowlist.',
      );
    const vendor = named[0]!;
    if (vendor.addresses[0]?.status !== 'VERIFIED')
      return refuse(
        `${vendor.name} is not on the vault allowlist, so Synq cannot draft a deal with them.`,
      );
    const freelancerWallet = vendor.addresses[0]!.address;
    const arbiterWallet = owners.find(
      (o) => !isAddressEqual(o, owner) && !isAddressEqual(o, freelancerWallet),
    );
    if (!arbiterWallet)
      return refuse('No independent vault co-owner is available as arbiter.');
    const party = (
      role: Party['role'],
      displayName: string,
      principalId: string,
      wallet: Address,
      reference: string,
      verifiedAt: number,
    ): Party => ({
      role,
      displayName,
      principalId,
      wallet,
      verification: {
        method: 'GOVERNANCE_MEMBER',
        reference,
        channel: null,
        channelUserId: null,
        verifiedAt,
      },
    });
    const context = contextFromGuestQuery({
      envelope: {
        channel: 'imessage',
        externalGroupId: `fund:${fundId}`,
        messageId: `imsg_${randomBytes(8).toString('hex')}`,
        externalUserId: null,
        body: text,
        timestamp: now,
      },
      reference: null,
    });
    try {
      const view = await deals.service.draft({
        workspaceId: this.workspaceId,
        context,
        request: text,
        parties: {
          client: party(
            'CLIENT',
            this.deps.name,
            'arc-business-owner',
            owner,
            `safe-owner:${VAULT.safe}:${owner}`,
            now,
          ),
          freelancer: party(
            'FREELANCER',
            vendor.name,
            `vendor:${vendor.vendorId}`,
            freelancerWallet,
            `vault-allowlist:${VAULT.policy}:${freelancerWallet}`,
            vendor.addresses[0]!.at || now,
          ),
          arbiter: party(
            'ARBITER',
            `Vault co-owner ${arbiterWallet.slice(0, 6)}…${arbiterWallet.slice(-4)}`,
            `safe-owner:${arbiterWallet.toLowerCase()}`,
            arbiterWallet,
            `safe-owner:${VAULT.safe}:${arbiterWallet}`,
            now,
          ),
        },
        reasoner: this.deps.reasoner,
        fixtureKey: `imessage:${sha256(text).slice(0, 16)}`,
      });
      const t = view.current.terms;
      const d = (u: bigint) => decimalOf(u, t.asset.decimals);
      const id = view.deal.dealId;
      return {
        ...NETWORK,
        mode: 'LIVE_ARC_TESTNET',
        status: 'DRAFTED' as const,
        dealId: id,
        title: t.title,
        total: d(t.total),
        symbol: t.asset.symbol,
        milestones: t.milestones.map((m) => ({
          title: m.title,
          amount: d(m.amount),
          due: new Date(m.deadline * 1000).toISOString().slice(0, 10),
        })),
        client: t.client.displayName,
        freelancer: t.freelancer.displayName,
        arbiter: t.arbiter.displayName,
        ambiguities: view.current.ambiguities.slice(0, 5),
        reviewUrl: `${this.web}/deal/${id}?t=${dealLinkToken(
          deals.linkKey,
          id,
          {
            expiresAt: now + DEAL_LINK_TTL_SECONDS,
            epoch: view.deal.linkEpoch ?? 0,
          },
        )}`,
      };
    } catch (e) {
      if (e instanceof DealRoomError) return refuse(e.message);
      throw e;
    }
  }

  private invoiceView(i: Invoice, fundId: string) {
    const inv = this.deps.invoices!;
    const payPath = payPathFor(inv.payLinkKey, i);
    const payUrl = payPath ? `${this.web}${payPath}` : null;
    const issueUrl =
      i.status === 'DRAFT'
        ? `${this.web}/invoice/${i.invoiceId}?t=${issueLinkToken(
            inv.payLinkKey,
            i.invoiceId,
            (i.history[0]?.at ?? this.deps.now()) + ISSUE_LINK_TTL_SECONDS,
          )}`
        : null;
    return {
      ...NETWORK,
      mode: 'LIVE_ARC_TESTNET',
      invoiceId: i.invoiceId,
      number: i.number,
      status: i.status,
      payer: i.payer.name,
      description: i.lineItems[0]?.description ?? '',
      total: usdcText(i.total),
      paid: usdcText(i.paid),
      symbol: i.asset.symbol,
      dueDate: i.dueDate,
      issuer: i.issuer.name,
      payTo: i.issuer.payoutAddress,
      issueUrl,
      payUrl,
      card: invoiceCard(i, {
        groupId: fundId,
        groupLabel: this.deps.name,
        executionMode: 'LIVE_ARC_TESTNET',
        issuedAt: this.deps.now(),
        actions: payUrl
          ? [
              {
                kind: 'VIEW' as const,
                label: 'Open checkout',
                url: payUrl,
                style: 'PRIMARY' as const,
              },
            ]
          : [],
      }),
    };
  }

  /** A DRAFT invoice from the business; the owner's wallet issues it on the Synq page. */
  async createInvoice(
    fundId: string,
    input: {
      payer: string;
      amount: string;
      description: string;
      dueInDays?: number | undefined;
    },
  ) {
    const inv = this.deps.invoices;
    if (!inv)
      throw new BusinessError(
        'NOT_ENABLED',
        503,
        'Invoices are not enabled on this server yet.',
      );
    const amount = usdcUnits(input.amount);
    const now = this.deps.now();
    const { owner } = await this.owner();
    const due = new Date((now + (input.dueInDays ?? 14) * 86_400) * 1000)
      .toISOString()
      .slice(0, 10);
    try {
      const draft = draftInvoice({
        workspaceId: this.workspaceId,
        number: `SYNQ-${randomBytes(3).toString('hex').toUpperCase()}`,
        issuer: {
          principalId: 'arc-business-owner',
          name: this.deps.name,
          wallet: owner,
          payoutAddress: VAULT.safe,
        },
        payer: { name: input.payer, contact: null },
        asset: USDC,
        lineItems: [
          { description: input.description, quantity: 1, unitPrice: amount },
        ],
        dueDate: due,
        memo: `drafted in iMessage for fund ${fundId}`,
        draftedBy: `fund:${fundId}`,
        now,
      });
      const stored = await inv.service.create(draft);
      return this.invoiceView(stored.invoice, fundId);
    } catch (e) {
      if (e instanceof InvoiceError)
        throw new BusinessError('BAD_AMOUNT', 400, e.message);
      throw e;
    }
  }

  /** Only the fund that drafted an invoice can read it back. */
  async invoice(fundId: string, invoiceId: string) {
    const inv = this.deps.invoices;
    if (!inv)
      throw new BusinessError(
        'NOT_ENABLED',
        503,
        'Invoices are not enabled on this server yet.',
      );
    const cur = await inv.service.store.get(invoiceId);
    if (!cur || cur.invoice.draftedBy !== `fund:${fundId}`)
      throw new BusinessError('NOT_FOUND', 404, 'No such invoice.');
    return this.invoiceView(cur.invoice, fundId);
  }
}
