import { describe, expect, it } from 'vitest';
import {
  isAddressEqual,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { moneyFromDecimal } from '@synq/domain';
import { chainProfile, contract, token } from '@synq/chain-registry/arc';
import {
  UsycError,
  checkUsycEntitlement,
  planUsycSubscription,
  type UsycEntitlement,
  type UsycReader,
} from '@synq/plugin-usyc';
import { ArcExecutionError, prepareTransfer } from '@synq/execution-worker/arc';
import {
  ImmersveCardRoute,
  LithicEnvironmentError,
  assertLithicSandbox,
  lithicProviderCapability,
  settlementFabricCapabilities,
} from '@synq/plugin-commerce';
import {
  executionBlocker,
  receiptStatement,
  selectExecutionRoute,
  type ExecutionNeed,
} from '@synq/settlement';
import {
  EnvVaultKeyProvider,
  MemoryProfileStore,
  ProfileAccessError,
  ProfileDecryptor,
  ProfileDirectory,
  redact,
} from '@synq/profile-vault';
import {
  DealRoomError,
  contextFromEnrolled,
  resolveCitations,
} from '@synq/dealroom';
import {
  MemoryRiskCaseStore,
  RiskCaseService,
  screenSafely,
  screeningFlags,
  unavailableScreening,
  type WalletScreeningPort,
} from '@synq/plugin-risk';
import {
  decideYieldDeposit,
  normalizeVault,
  type YieldReservePort,
} from '@synq/plugin-circle-earn';
import code from '../arc/fixtures/usyc-proxy-code.json' with { type: 'json' };
import { GROUP, T0, enrolledChat, parties, room } from '../dealroom/harness.js';

/**
 * Cross-cutting LEGAL rows (X-LEG-01..07): eligibility, regional and KYC
 * gates, PII, consent/retention, sanctions screening, disclosure and
 * truthful capability claims. Real plugin/service code, LOCAL_FIXTURE inputs.
 */

const teller = contract('arc-testnet', 'USYC_TELLER').address;
const entitlements = contract('arc-testnet', 'USYC_ENTITLEMENTS').address;
const usdc = token('arc-testnet', 'USDC');
const usyc = token('arc-testnet', 'USYC');
const retail = `0x${'1'.repeat(40)}` as Address;
const now = Date.parse('2026-10-16T06:20:00Z');

/** Read-only Arc double (values as observed 2026-10-16): nobody is allowlisted. */
const usycChain = (allowlisted: Address[] = []): UsycReader => ({
  async getCode({ address }) {
    if (isAddressEqual(address, teller)) return code.teller as Hex;
    if (isAddressEqual(address, entitlements)) return code.entitlements as Hex;
    return undefined;
  },
  async readContract({ address, functionName, args }) {
    if (isAddressEqual(address, teller)) {
      if (functionName === 'authority') return entitlements;
      if (functionName === 'asset') return usdc.address;
      if (functionName === 'share') return usyc.address;
    }
    const user = (args?.[0] ?? '0x') as Address;
    const ok = allowlisted.some((a) => isAddressEqual(a, user));
    if (functionName === 'canCall') return ok;
    if (functionName === 'isCapabilityPublic') return false;
    if (functionName === 'getUserRoles')
      return `0x${'0'.repeat(63)}${ok ? 1 : 0}`;
    if (functionName === 'getRolesWithCapability')
      return `0x${'0'.repeat(60)}0201`;
    throw new Error(`unexpected read ${functionName}`);
  },
});

/** A client that fails the test if any RPC is attempted. */
const noRpc = new Proxy(
  {},
  {
    get: (_t, p) => () => {
      throw new Error(`unexpected RPC ${String(p)}`);
    },
  },
) as PublicClient;

describe('cross-cutting LEGAL (X-LEG)', () => {
  it('X-LEG-01 an unentitled (retail) wallet can never deposit into USYC', async () => {
    const e = await checkUsycEntitlement(usycChain(), retail, 'deposit', now);
    expect(e.status).toBe('INELIGIBLE');
    const amount = moneyFromDecimal(usdc, '1');
    expect(() =>
      planUsycSubscription({ entitlement: e, wallet: retail, amount, now }),
    ).toThrow(UsycError);
    // A hand-made "ELIGIBLE" record (e.g. from model output) is not a chain read.
    const forged: UsycEntitlement = { ...e, status: 'ELIGIBLE', canCall: true };
    expect(() =>
      planUsycSubscription({
        entitlement: forged,
        wallet: retail,
        amount,
        now,
      }),
    ).toThrow(/fresh verified chain read/);
    // Even a stale eligible read stops working.
    const ok = await checkUsycEntitlement(
      usycChain([retail]),
      retail,
      'deposit',
      now,
    );
    expect(() =>
      planUsycSubscription({
        entitlement: ok,
        wallet: retail,
        amount,
        now: now + 120_000,
      }),
    ).toThrow(/STALE_ENTITLEMENT|re-read/);
    // The executor refuses to move a permissioned asset before any RPC.
    await expect(
      prepareTransfer(
        { profile: chainProfile('arc-testnet'), client: noRpc },
        { from: retail, to: teller, amount: moneyFromDecimal(usyc, '1') },
      ),
    ).rejects.toThrow(ArcExecutionError);
    await expect(
      prepareTransfer(
        { profile: chainProfile('arc-testnet'), client: noRpc },
        { from: retail, to: teller, amount: moneyFromDecimal(usyc, '1') },
      ),
    ).rejects.toMatchObject({ code: 'MUTATION_DISABLED' });
  });

  it('X-LEG-02 a regional payment method that is not allowed (or unmet KYC) is refused, never bypassed', () => {
    const route = new ImmersveCardRoute(
      {
        providerId: 'immersve',
        displayName: 'Immersve',
        domains: ['COMMERCE'],
        verbs: ['PAY'],
        environment: 'SANDBOX',
        status: 'READY',
        statusReason: null,
        kycRequired: true,
        credentialEnv: [],
        settlementRails: ['SCOPED_CARD'],
        discoveryOnly: false,
        sourceRefs: [],
      },
      {
        supportedRegions: ['NZ', 'AU'],
        settlementPrincipalId: 'prn_owner',
        credentialsPresent: true,
      },
    );
    const holder = {
      principalId: 'prn_owner',
      kycStatus: 'APPROVED' as const,
      residenceCountry: 'NZ',
    };
    expect(route.eligibility(holder)).toEqual({ eligible: true });
    expect(route.eligibility({ ...holder, residenceCountry: 'US' })).toEqual({
      eligible: false,
      code: 'REGION_UNSUPPORTED',
    });
    for (const kycStatus of ['PENDING', 'REJECTED', 'NONE'] as const)
      expect(route.eligibility({ ...holder, kycStatus })).toEqual({
        eligible: false,
        code: 'KYC_INCOMPLETE',
      });
    expect(
      route.eligibility({ ...holder, principalId: 'prn_someone_else' }),
    ).toMatchObject({ code: 'WRONG_SETTLEMENT_PRINCIPAL' });
    // At the settlement router: a provider whose identity checks are unmet is
    // never selected, whatever else it offers.
    const lithic = settlementFabricCapabilities({ LITHIC_API_KEY: 'k' }).find(
      (c) => c.providerId === 'lithic-sandbox',
    )!;
    const need: ExecutionNeed = {
      intentId: 'x',
      product: 'VIRTUAL_CARD_AUTHORIZATION',
      currency: 'USD',
      requiredChain: null,
      allowedModes: ['PROVIDER_SANDBOX'],
      categories: ['CARD_NETWORK_SANDBOX'],
    };
    expect(executionBlocker(lithic, need)).toBeNull();
    const kycGated = {
      ...lithic,
      identityChecks: ['CARDHOLDER_KYC' as const],
      identitySatisfied: false,
    };
    expect(executionBlocker(kycGated, need)).toMatch(/identity checks unmet/);
    expect(selectExecutionRoute(need, [kycGated]).status).toBe('UNAVAILABLE');
    // A currency the provider does not serve is refused too.
    expect(executionBlocker(lithic, { ...need, currency: 'EUR' })).toMatch(
      /currency EUR/,
    );
  });

  it('X-LEG-03 private traveler PII never reaches a chat notification', async () => {
    const keys = new EnvVaultKeyProvider({
      SYNQ_PROFILE_VAULT_KEY: Buffer.alloc(32, 7).toString('base64'),
    });
    const store = new MemoryProfileStore();
    const pii = {
      givenName: 'Ada',
      familyName: 'Lovelace',
      bornOn: '1990-12-10',
      email: 'ada@example.com',
      phone: '+447700900123',
      passportNumber: 'P1234567',
      passportCountry: 'GB',
      passportExpiry: '2031-01-01',
    };
    const { ref, summary } = await new ProfileDirectory(
      store,
      keys,
      () => T0,
    ).put({ groupId: 'grp_trip', kind: 'TRAVELER', data: pii });
    expect(ref).toMatch(/^pv_[0-9a-f]{32}$/);
    // What a chat notification is built from: the ref and the summary only.
    const notification = `Booked LHR-JFK for ${summary} (${ref}).`;
    for (const v of [
      pii.givenName,
      pii.familyName,
      pii.email,
      pii.phone,
      pii.passportNumber,
      pii.bornOn,
    ])
      expect(notification).not.toContain(v);
    // Free text a provider or model might echo is redacted before it is posted.
    const echoed = `Ticket for ${pii.email} ${pii.phone}, passport no. ${pii.passportNumber}, card 4111 1111 1111 1111`;
    const safe = redact(echoed);
    for (const v of [pii.email, pii.phone, pii.passportNumber, '4111 1111'])
      expect(safe).not.toContain(v);
    // Another group's worker cannot decrypt the profile (and the denial is audited).
    const worker = new ProfileDecryptor(store, keys, () => T0, 'chat-bot');
    await expect(
      worker.resolve({
        groupId: 'grp_other',
        ref,
        kind: 'TRAVELER',
        purpose: 'notify',
        fields: ['email'],
      }),
    ).rejects.toThrow(ProfileAccessError);
    expect(worker.audit[0]).toMatchObject({
      outcome: 'DENIED',
      reason: 'WRONG_GROUP',
    });
  });

  it('X-LEG-04 a deleted transcript (consent withdrawn or retention ended) cannot shape a later agreement', async () => {
    const { store, svc, context } = await enrolledChat();
    // While consented, message 902 (the price) is citable.
    expect(
      resolveCitations(context, [
        { term: 'total', messageId: '902', quote: '0.03 USDC total' },
      ]).total,
    ).toHaveLength(1);
    // The freelancer withdraws consent: their stored messages are deleted.
    expect(await store.revokeConsent('telegram', GROUP, '7002')).toBe(1);
    const after = await svc.contextFor({
      channel: 'telegram',
      externalGroupId: GROUP,
      groupId: 'grp_landing',
      now: T0,
    });
    expect(after.map((m) => m.messageId)).toEqual(['901', '903']);
    const ctx = contextFromEnrolled({
      channel: 'telegram',
      externalGroupId: GROUP,
      stored: after,
      invocation: {
        messageId: '905',
        principalId: 'prn_dana',
        text: '/deal draft this',
        sentAt: T0,
      },
    });
    expect(() =>
      resolveCitations(ctx, [
        { term: 'total', messageId: '902', quote: '0.03 USDC total' },
      ]),
    ).toThrow(DealRoomError);
    // A fresh draft from what remains carries nothing from the deleted message.
    const r = room();
    let drafted: unknown = null;
    try {
      drafted = await r.service.draft({
        workspaceId: 'wsp_dealroom_test',
        context: ctx,
        request: 'draft this',
        parties,
        reasoner: null,
      });
    } catch (e) {
      // Refusing to draft without the price is also acceptable; inventing it is not.
      expect(e).toBeInstanceOf(DealRoomError);
    }
    const text = JSON.stringify(drafted, (_k, v: unknown) =>
      typeof v === 'bigint' ? v.toString() : v,
    );
    if (drafted) {
      const view = drafted as {
        deal: { origin: { messages: Record<string, string> } };
        current: { terms: { total: string } };
      };
      // The deleted price is not in the deal's authorized context and is not
      // reconstructed: the amount stays unstated (0) for the parties to fill in.
      expect(Object.keys(view.deal.origin.messages)).not.toContain('902');
      expect(String(view.current.terms.total)).toBe('0');
    }
    expect(text).not.toContain('"902"');
    expect(text).not.toContain('0.03 USDC total');
    // Retention: once a message expires it is purged and no longer readable.
    expect(await svc.purge(T0 + 8 * 86_400)).toBe(2);
    expect(
      await svc.contextFor({
        channel: 'telegram',
        externalGroupId: GROUP,
        groupId: 'grp_landing',
        now: T0 + 8 * 86_400,
      }),
    ).toEqual([]);
  });

  it('X-LEG-05 a payment to a sanctioned address is blocked and a reviewer cannot override it', async () => {
    const sanctioned = `0x${'5a'.repeat(20)}` as Address;
    const provider: WalletScreeningPort = {
      providerId: 'TEST_SCREENING',
      status: () => ({
        providerId: 'TEST_SCREENING',
        status: 'AVAILABLE',
        missingCredentials: [],
        reason: 'fixture',
      }),
      screen: async ({ address, chainId, now: at }) => ({
        providerId: 'TEST_SCREENING',
        address,
        chainId,
        verdict: 'HIT',
        reference: 'list:OFAC-SDN#fixture',
        reason: 'listed',
        screenedAt: at,
      }),
    };
    const input = { address: sanctioned, chainId: 5042002, now: T0 };
    const hit = await screenSafely(provider, input);
    expect(hit.verdict).toBe('HIT');
    const { flags } = screeningFlags({
      result: hit,
      amount: 1n,
      highValueAt: 1_000_000n,
      counterpartyVerified: true,
    });
    expect(flags).toEqual([
      expect.objectContaining({ code: 'SCREENING_HIT', severity: 'HARD' }),
    ]);
    // No provider configured: never a pass; fail closed for an unverified payee.
    const none = await screenSafely(unavailableScreening(), input);
    expect(none.verdict).toBe('UNAVAILABLE');
    expect(
      screeningFlags({
        result: none,
        amount: 1n,
        highValueAt: 1_000_000n,
        counterpartyVerified: false,
      }).flags[0]!.severity,
    ).toBe('HARD');
    const cases = new RiskCaseService(new MemoryRiskCaseStore(), () => T0);
    const opened = await cases.raise({
      workspaceId: 'wsp_legal',
      alertKey: 'screen-1',
      subjectRef: `payout:${sanctioned}`,
      counterparty: sanctioned,
      flags,
      raisedBy: 'RISK',
      at: T0,
    });
    const id = opened.case!.caseId;
    const owner = {
      principalId: 'prn_owner',
      kind: 'HUMAN' as const,
      role: 'OWNER' as const,
      proof: 'eip712:fixture',
    };
    const reviewed = await cases.review(id, owner, 'RELEASE', 'looks fine');
    expect(reviewed.refused).toContain('SCREENING_HIT');
    expect(reviewed.case.status).not.toBe('RELEASED');
    await expect(
      cases.review(id, { ...owner, kind: 'AGENT' }, 'RELEASE', 'model says ok'),
    ).rejects.toThrow(/human/);
  });

  it('X-LEG-06 the withdrawal limits are disclosed before any yield deposit', async () => {
    const pin = contract('arc-testnet', 'CIRCLE_EARN_VAULT_USDC');
    const t = Date.parse('2026-10-16T05:57:03Z');
    const vault = normalizeVault(
      {
        vaultAddress: pin.address.toLowerCase(),
        chain: 'Arc_Testnet',
        name: 'EarnKit USDC Vault (Arc Testnet)',
        protocol: 'MORPHO',
        asset: 'USDC',
        assetAddress: usdc.address,
        currentApy: 0.042,
        status: 'active',
        asOf: '2026-10-16T05:55:09Z',
        apyProfile: {
          source: 'morpho:avgNetApy',
          asOf: '2026-10-16T05:55:09Z',
        },
        riskSignals: {
          circleSentinel: false,
          warnings: [],
          earnKitWarnings: [],
        },
        liquidity: '1000000.0',
      },
      { observedAt: t },
    );
    const open: YieldReservePort = {
      canDeployToYield: async () => ({ allowed: true }),
    };
    const d = await decideYieldDeposit({
      vault,
      amount: moneyFromDecimal(usdc, '0.05'),
      now: t + 1_000,
      policy: {
        minApyBps: 1,
        maxDeposit: moneyFromDecimal(usdc, '0.05'),
        allowTestVaults: true,
      },
      reserves: open,
    });
    expect(d.decision).toBe('DEPOSIT');
    if (d.decision !== 'DEPOSIT') return;
    expect(d.withdrawalTerms).toMatch(/not guaranteed to be instant/);
    expect(d.withdrawalTerms).toMatch(/reported 1000000.0 USDC/);
    // The text shown with the decision carries both the APY caveat and the withdrawal terms.
    expect(d.justification).toMatch(/not guaranteed, can change/);
    expect(d.justification).toContain(d.withdrawalTerms);
    // USYC: the permissioned fund is never offered to an unentitled wallet at all.
    const e = await checkUsycEntitlement(usycChain(), retail, 'deposit', now);
    expect(e.explanation).toMatch(/will not attempt or simulate/);
  });

  it('X-LEG-07 real card issuing is never advertised or routed as available', () => {
    // Production Lithic configuration is a construction error.
    expect(() =>
      assertLithicSandbox({ apiKey: 'k', environment: 'production' }),
    ).toThrow(LithicEnvironmentError);
    const prod = settlementFabricCapabilities({
      LITHIC_ENV: 'production',
      LITHIC_API_KEY: 'k',
    }).find((c) => c.providerId === 'lithic-sandbox')!;
    expect(prod.credentials).toBe('REFUSED_NON_SANDBOX');
    expect(lithicProviderCapability({ LITHIC_ENV: 'production' }).status).toBe(
      'BLOCKED',
    );
    const caps = settlementFabricCapabilities({ LITHIC_API_KEY: 'k' });
    for (const c of caps.filter((x) =>
      x.products.includes('VIRTUAL_CARD_AUTHORIZATION'),
    )) {
      if (c.category === 'HUMAN_HANDOFF') continue;
      expect(c.live.available).toBe(false);
      expect(c.economicEffect).not.toBe('REAL_MONEY');
      expect(c.displayName).toMatch(/sandbox/i);
    }
    // Even when a real-money mode is allowed by the need, nothing live is selected.
    const decision = selectExecutionRoute(
      {
        intentId: 'x',
        product: 'VIRTUAL_CARD_AUTHORIZATION',
        currency: 'USD',
        requiredChain: null,
        allowedModes: ['PROVIDER_SANDBOX', 'REAL_MONEY_APPROVAL_REQUIRED'],
        categories: ['CARD_NETWORK_SANDBOX', 'CRYPTO_COMMERCE_REAL'],
      },
      caps,
    );
    expect(decision.status).toBe('SELECTED');
    if (decision.status === 'SELECTED')
      expect(decision.mode).toBe('PROVIDER_SANDBOX');
    expect(
      receiptStatement({
        category: 'CARD_NETWORK_SANDBOX',
        mode: 'PROVIDER_SANDBOX',
        providerName: 'Lithic',
      }),
    ).toMatch(/simulated card payment/);
    // The regulated card rail is not live without credentials and a KYC'd holder.
    const immersve = new ImmersveCardRoute(
      {
        providerId: 'immersve',
        displayName: 'Immersve',
        domains: ['COMMERCE'],
        verbs: ['PAY'],
        environment: 'SANDBOX',
        status: 'BLOCKED',
        statusReason: null,
        kycRequired: true,
        credentialEnv: [],
        settlementRails: ['SCOPED_CARD'],
        discoveryOnly: false,
        sourceRefs: [],
      },
      {
        supportedRegions: ['NZ'],
        settlementPrincipalId: null,
        credentialsPresent: false,
      },
    );
    expect(immersve.sandboxReady()).toBe(false);
    expect(
      immersve.eligibility({
        principalId: 'p',
        kycStatus: 'APPROVED',
        residenceCountry: 'NZ',
      }),
    ).toEqual({ eligible: false, code: 'NOT_CONFIGURED' });
  });
});
