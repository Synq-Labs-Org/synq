import { describe, expect, it } from 'vitest';
import {
  CreateWorkspaceSchema,
  WalletSchema,
  defaultThreshold,
  loginTypedData,
} from '../../packages/workspaces/src/contracts.js';
import { workspaceCapabilities } from '../../apps/demo/src/workspace-routes.js';

describe('G1 workspace contracts', () => {
  it('rejects caller-selected custody, chain, role and vault', () => {
    for (const extra of [
      { vault: 'arbitrary' },
      { chainId: 1 },
      { role: 'OWNER' },
      { status: 'ACTIVE' },
    ])
      expect(
        CreateWorkspaceSchema.safeParse({
          displayName: 'Accounts',
          kind: 'GROUP',
          ...extra,
        }).success,
      ).toBe(false);
  });
  it('bounds group thresholds and uses one signature for personal custody', () => {
    expect([1, 2, 3, 4, 20].map(defaultThreshold)).toEqual([1, 2, 3, 3, 3]);
    for (const n of [0, -1, 21, 1.5, NaN])
      expect(() => defaultThreshold(n)).toThrow();
  });
  it('rejects invalid and reserved owner wallets', () => {
    for (const w of ['someone', `0x${'0'.repeat(40)}`, `0x${'0'.repeat(39)}1`])
      expect(WalletSchema.safeParse(w).success).toBe(false);
  });
});

describe('G2 onboarding capability truth', () => {
  it('never reports unconnected finance or channel integrations as available', () => {
    const c = workspaceCapabilities();
    expect(c.chainId).toBe(5042002);
    expect(c.workspaces.scope).toBe('IDENTITY_AND_FORMATION_ONLY');
    for (const key of [
      'vaultCreation',
      'circleWallets',
      'gasStation',
      'usyc',
      'earn',
      'swap',
      'duffel',
      'lithic',
      'cctp',
      'gateway',
      'channelBinding',
    ] as const)
      expect(c[key]).toMatchObject({
        status: 'BLOCKED',
        reason: expect.any(String),
      });
  });
  it('G11 reports payout execution available only with a payout worker and an AVAILABLE screener, naming its scope', () => {
    const sdn = {
      status: 'AVAILABLE',
      providerId: 'OFAC_SDN_LIST_ONLY',
      reason: 'OFAC SDN list only (not full wallet screening)',
    };
    expect(
      workspaceCapabilities(true, true, true, false, sdn).payoutExecution,
    ).toMatchObject({ status: 'BLOCKED' });
    expect(
      workspaceCapabilities(true, true, true, true, {
        ...sdn,
        status: 'UNAVAILABLE',
        reason: 'snapshot is stale',
      }).payoutExecution,
    ).toMatchObject({
      status: 'BLOCKED',
      reason: expect.stringMatching(/stale/),
    });
    expect(
      workspaceCapabilities(true, true, true, true, sdn).payoutExecution,
    ).toMatchObject({
      status: 'AVAILABLE',
      screening: 'OFAC_SDN_LIST_ONLY',
      reason: expect.stringMatching(/not full wallet screening/),
    });
  });
  it('signs the intended origin, audience, chain, expiry and no-money statement', () => {
    const typed = loginTypedData({
      id: 'challenge',
      wallet: `0x${'2'.repeat(40)}`,
      origin: 'https://synq.test',
      audience: 'native',
      nonce: 'nonce',
      expiresAt: 100,
    });
    expect(typed.domain.chainId).toBe(5042002);
    expect(typed.message).toMatchObject({
      origin: 'https://synq.test',
      audience: 'native',
      expiresAt: '100',
    });
    expect(typed.message.statement).toContain('does not approve payments');
  });
});
