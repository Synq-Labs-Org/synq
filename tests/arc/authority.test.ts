import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import type { Address, Hex } from 'viem';
import { token } from '@synq/chain-registry/arc';
import {
  AuthorityError,
  MemoryNonceFence,
  admitGrant,
  decide,
  intentApprovalTypedData,
  mandateTypedData,
  type AuthorityConfig,
  type PaymentIntent,
  type PaymentMandate,
} from '@synq/kernel/arc';

const owner = privateKeyToAccount(`0x${'11'.repeat(32)}`);
const stranger = privateKeyToAccount(`0x${'22'.repeat(32)}`);
const USDC = token('arc-testnet', 'USDC');
const payer = `0x${'a1'.repeat(20)}` as Address;
const sarah = `0x${'5a'.repeat(20)}` as Address;
const attacker = `0x${'ba'.repeat(20)}` as Address;
const NOW = 1_790_000_000;
const config: AuthorityConfig = {
  grantKey: new Uint8Array(32).fill(7),
  operator: 'arc-executor-1',
  grantTtlSeconds: 120,
  riskRequiredAbove: 50_000_000n,
};
const mandate: PaymentMandate = {
  mandateId: 'mnd_contractors',
  version: 1,
  workspaceId: 'wsp_freelancer',
  owner: owner.address,
  chainId: USDC.chainId,
  token: USDC.address,
  payer,
  recipients: [sarah],
  purposes: ['CONTRACTOR_PAYOUT'],
  perActionCap: 100_000_000n, // 100 USDC
  periodBudget: 250_000_000n,
  periodSeconds: 30 * 86_400,
  validFrom: NOW - 60,
  validUntil: NOW + 30 * 86_400,
};
const intent = (over: Partial<PaymentIntent> = {}): PaymentIntent => ({
  intentId: 'int_1',
  mandateId: mandate.mandateId,
  mandateVersion: 1,
  chainId: USDC.chainId,
  token: USDC.address,
  payer,
  recipient: sarah,
  amount: 100_000_000n,
  purpose: 'CONTRACTOR_PAYOUT',
  obligationRef: 'pay_design_milestone_2',
  evidenceHash: `0x${'e1'.repeat(32)}`,
  proposedBy: 'agent:payments',
  ...over,
});
const clean = { flags: [], available: true } as const;
const sign = (m: PaymentMandate, by = owner) =>
  by.signTypedData(mandateTypedData(m));

async function allow(over: Partial<PaymentIntent> = {}) {
  const d = await decide({
    config,
    mandate,
    mandateSignature: await sign(mandate),
    state: { revoked: false, spends: [] },
    intent: intent(over),
    risk: clean,
    simulationOk: true,
    now: NOW,
  });
  if (d.outcome !== 'ALLOW') throw new Error(d.reasons.join('; '));
  return d.grant;
}
const call = (
  over: Partial<{
    chainId: number;
    token: Address;
    payer: Address;
    recipient: Address;
    amount: bigint;
  }> = {},
) => ({
  chainId: USDC.chainId,
  token: USDC.address,
  payer,
  recipient: sarah,
  amount: 100_000_000n,
  ...over,
});

describe('Arc payment authority', () => {
  it('allows the exact bounded payout and admits only that exact call once (P06 PASS shape)', async () => {
    const grant = await allow();
    expect(grant).toMatchObject({
      recipient: sarah,
      amount: '100000000',
      issuedByKernel: true,
    });
    const fence = new MemoryNonceFence();
    await admitGrant({
      grantKey: config.grantKey,
      grant,
      call: call(),
      now: NOW + 5,
      mandateRevoked: false,
      fence,
    });
    // P06-03: the same grant cannot run twice.
    await expect(
      admitGrant({
        grantKey: config.grantKey,
        grant,
        call: call(),
        now: NOW + 6,
        mandateRevoked: false,
        fence,
      }),
    ).rejects.toMatchObject({ code: 'GRANT_REPLAYED' });
  });

  it('P06-02 a granted call with a changed recipient, vault, chain, asset or amount is refused', async () => {
    const grant = await allow();
    for (const changed of [
      call({ recipient: attacker }),
      call({ payer: `0x${'a2'.repeat(20)}` }),
      call({ chainId: 11155111 }),
      call({ token: token('arc-testnet', 'EURC').address }),
      call({ amount: 100_000_001n }),
      call({ amount: 99_999_999n }),
    ])
      await expect(
        admitGrant({
          grantKey: config.grantKey,
          grant,
          call: changed,
          now: NOW,
          mandateRevoked: false,
          fence: new MemoryNonceFence(),
        }),
      ).rejects.toMatchObject({ code: 'GRANT_MISMATCH' });
  });

  it('P06-01 / P06-04 an intent without a Kernel grant, or a grant minted by anyone else, cannot reach the executor', async () => {
    const real = await allow();
    // An agent fabricating a grant (no Kernel key) or editing one fails the MAC.
    const forged = { ...real, recipient: attacker };
    const selfMinted = { ...real, mac: `0x${'00'.repeat(32)}` as Hex };
    for (const g of [forged, selfMinted])
      await expect(
        admitGrant({
          grantKey: config.grantKey,
          grant: g,
          call: call({ recipient: g.recipient }),
          now: NOW,
          mandateRevoked: false,
          fence: new MemoryNonceFence(),
        }),
      ).rejects.toMatchObject({ code: 'GRANT_FORGED' });
    // A grant verified with a different key (another environment) is not accepted either.
    await expect(
      admitGrant({
        grantKey: new Uint8Array(32).fill(9),
        grant: real,
        call: call(),
        now: NOW,
        mandateRevoked: false,
        fence: new MemoryNonceFence(),
      }),
    ).rejects.toMatchObject({ code: 'GRANT_FORGED' });
  });

  it('P06-06 expired grants, expired mandates and revoked mandates stop the payment', async () => {
    const grant = await allow();
    await expect(
      admitGrant({
        grantKey: config.grantKey,
        grant,
        call: call(),
        now: grant.expiresAt,
        mandateRevoked: false,
        fence: new MemoryNonceFence(),
      }),
    ).rejects.toMatchObject({ code: 'GRANT_EXPIRED' });
    await expect(
      admitGrant({
        grantKey: config.grantKey,
        grant,
        call: call(),
        now: NOW,
        mandateRevoked: true,
        fence: new MemoryNonceFence(),
      }),
    ).rejects.toMatchObject({ code: 'GRANT_REVOKED' });
    const sig = await sign(mandate);
    const base = {
      config,
      mandate,
      mandateSignature: sig,
      intent: intent(),
      risk: clean,
      simulationOk: true,
    };
    expect(
      (
        await decide({
          ...base,
          state: { revoked: true, spends: [] },
          now: NOW,
        })
      ).outcome,
    ).toBe('DENY');
    expect(
      (
        await decide({
          ...base,
          state: { revoked: false, spends: [] },
          now: mandate.validUntil,
        })
      ).outcome,
    ).toBe('DENY');
  });

  it('P06-07 a failed simulation issues no grant', async () => {
    const d = await decide({
      config,
      mandate,
      mandateSignature: await sign(mandate),
      state: { revoked: false, spends: [] },
      intent: intent(),
      risk: clean,
      simulationOk: false,
      now: NOW,
    });
    expect(d).toMatchObject({
      outcome: 'DENY',
      reasons: ['simulation failed: no grant'],
    });
  });

  it('denies off-allowlist recipients, wrong purpose, exhausted budget and hard risk; fails closed without risk', async () => {
    const base = {
      config,
      mandate,
      mandateSignature: await sign(mandate),
      simulationOk: true,
      now: NOW,
    };
    const run = (o: Partial<Parameters<typeof decide>[0]>) =>
      decide({
        ...base,
        state: { revoked: false, spends: [] },
        intent: intent(),
        risk: clean,
        ...o,
      });
    expect(
      await run({ intent: intent({ recipient: attacker }) }),
    ).toMatchObject({
      outcome: 'DENY',
      reasons: [`recipient ${attacker} is not on the mandate allowlist`],
    });
    expect(
      (await run({ intent: intent({ purpose: 'RECURRING_BILL' }) })).outcome,
    ).toBe('DENY');
    expect(
      (
        await run({
          state: {
            revoked: false,
            spends: [{ amount: 200_000_000n, at: NOW - 100 }],
          },
        })
      ).outcome,
    ).toBe('DENY');
    // Spend from before the rolling window no longer counts.
    expect(
      (
        await run({
          state: {
            revoked: false,
            spends: [{ amount: 200_000_000n, at: NOW - 31 * 86_400 }],
          },
        })
      ).outcome,
    ).toBe('ALLOW');
    const changed = await run({
      risk: {
        available: true,
        flags: [
          {
            code: 'PAYOUT_ADDRESS_CHANGED',
            severity: 'HARD',
            detail: 'Sarah’s verified wallet differs',
          },
        ],
      },
    });
    expect(changed).toMatchObject({
      outcome: 'DENY',
      reasons: ['risk PAYOUT_ADDRESS_CHANGED: Sarah’s verified wallet differs'],
    });
    // P12-07: risk outage fails closed above the threshold, small payments proceed.
    expect((await run({ risk: { available: false, flags: [] } })).outcome).toBe(
      'DENY',
    );
    expect(
      (
        await run({
          risk: { available: false, flags: [] },
          intent: intent({ amount: 10_000_000n }),
        })
      ).outcome,
    ).toBe('ALLOW');
  });

  it('P06-05 / P03-05 only the owner’s EIP-712 signature on the right chain approves; votes and other signers do not', async () => {
    const overCap = intent({ amount: 150_000_000n });
    const base = {
      config,
      mandate,
      mandateSignature: await sign(mandate),
      state: { revoked: false, spends: [] },
      risk: clean,
      simulationOk: true,
      now: NOW,
    };
    const asked = await decide({ ...base, intent: overCap });
    expect(asked.outcome).toBe('REQUIRE_OWNER_APPROVAL');
    if (asked.outcome !== 'REQUIRE_OWNER_APPROVAL') throw new Error('asked');
    const terms = asked.approval;
    expect(terms.deadline).toBe(NOW + 900);
    const approve = (signature: Hex, t = terms) => ({ ...t, signature });
    // A "telegram vote" is not a signature at all.
    expect(
      (
        await decide({
          ...base,
          intent: overCap,
          ownerApproval: approve('0x74656c656772616d2d766f7465' as Hex),
        })
      ).outcome,
    ).toBe('DENY');
    expect(
      (
        await decide({
          ...base,
          intent: overCap,
          ownerApproval: approve(
            await stranger.signTypedData(
              intentApprovalTypedData(overCap, terms),
            ),
          ),
        })
      ).outcome,
    ).toBe('DENY');
    // Signed for another chain (Sepolia domain): wrong domain, not accepted.
    const wrongDomain = await owner.signTypedData({
      ...intentApprovalTypedData(overCap, terms),
      domain: {
        name: 'Synq Payment Approval',
        version: '1',
        chainId: 11155111,
      },
    });
    expect(
      (
        await decide({
          ...base,
          intent: overCap,
          ownerApproval: approve(wrongDomain),
        })
      ).outcome,
    ).toBe('DENY');
    const good = await owner.signTypedData(
      intentApprovalTypedData(overCap, terms),
    );
    expect(
      (await decide({ ...base, intent: overCap, ownerApproval: approve(good) }))
        .outcome,
    ).toBe('ALLOW');
    // The nonce and deadline are signed: changing either breaks the signature.
    expect(
      await decide({
        ...base,
        intent: overCap,
        ownerApproval: approve(good, {
          ...terms,
          deadline: terms.deadline + 3600,
        }),
      }),
    ).toMatchObject({
      outcome: 'DENY',
      reasons: ['owner approval signature does not match the mandate owner'],
    });
    // Expired, or already redeemed: refused even with the owner's signature.
    expect(
      await decide({
        ...base,
        now: terms.deadline + 1,
        intent: overCap,
        ownerApproval: approve(good),
      }),
    ).toMatchObject({ outcome: 'DENY', reasons: ['owner approval expired'] });
    expect(
      await decide({
        ...base,
        state: { ...base.state, usedApprovalNonces: [terms.nonce] },
        intent: overCap,
        ownerApproval: approve(good),
      }),
    ).toMatchObject({
      outcome: 'DENY',
      reasons: ['owner approval already used'],
    });
    // A mandate signed by a group admin who is not its owner creates no authority.
    expect(
      (
        await decide({
          ...base,
          mandateSignature: await sign(mandate, stranger),
          intent: intent(),
        })
      ).outcome,
    ).toBe('DENY');
    // A mandate whose terms were edited after signing is not the signed mandate.
    const edited = { ...mandate, recipients: [sarah, attacker] as Address[] };
    expect(
      (
        await decide({
          ...base,
          mandate: edited,
          intent: intent({ recipient: attacker }),
        })
      ).outcome,
    ).toBe('DENY');
  });

  it('rejects malformed mandates', async () => {
    for (const bad of [
      { ...mandate, perActionCap: 300_000_000n },
      { ...mandate, recipients: [] },
      { ...mandate, recipients: [payer] },
      { ...mandate, validUntil: mandate.validFrom },
    ])
      expect(
        (
          await decide({
            config,
            mandate: bad,
            mandateSignature: await sign(bad),
            state: { revoked: false, spends: [] },
            intent: intent(),
            risk: clean,
            simulationOk: true,
            now: NOW,
          })
        ).outcome,
      ).toBe('DENY');
    expect(AuthorityError).toBeDefined();
  });
});
