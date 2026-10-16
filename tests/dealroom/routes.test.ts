import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { hashTypedData } from 'viem';
import { dealLinkToken } from '@synq/dealroom';
import { dealRoutes } from '../../apps/api/src/deal-routes.js';
import { acceptSig, declineSig, drafted, room } from './harness.js';

const KEY = new Uint8Array(32).fill(3);

async function app() {
  const r = room();
  const d = await drafted(r);
  const server = Fastify();
  await server.register(dealRoutes, { service: r.service, linkKey: KEY });
  const id = d.view.deal.dealId;
  const t = dealLinkToken(KEY, id);
  return { server, r, d, id, t };
}

describe('Deal Room review and signing API', () => {
  it('serves the exact version with provenance and its EIP-712 message to a valid link only', async () => {
    const { server, d, id, t } = await app();
    const bad = await server.inject({
      method: 'GET',
      url: `/v1/deals/${id}?t=${'x'.repeat(32)}`,
    });
    expect(bad.statusCode).toBe(404);
    const res = await server.inject({
      method: 'GET',
      url: `/v1/deals/${id}?t=${t}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.termsHash).toBe(d.view.current.termsHash);
    expect(body.terms.total).toBe('0.03');
    expect(
      body.terms.milestones.map((m: { amount: string }) => m.amount),
    ).toEqual(['0.01', '0.02']);
    expect(body.provenance.total.map((p: { kind: string }) => p.kind)).toEqual([
      'ORIGINAL_MESSAGE',
      'AI_INTERPRETATION',
    ]);
    expect(body.acceptTypedData.domain).toMatchObject({
      name: 'Synq DealRoom',
      chainId: 5042002,
    });
    expect(body.acceptTypedData.types.EIP712Domain).toHaveLength(4);
    // The JSON message hashes to the version's terms hash once numbers are restored.
    const { EIP712Domain: _d, ...types } = body.acceptTypedData.types;
    const revive = (v: unknown): unknown =>
      Array.isArray(v)
        ? v.map(revive)
        : v && typeof v === 'object'
          ? Object.fromEntries(
              Object.entries(v).map(([k, x]) => [k, revive(x)]),
            )
          : typeof v === 'string' && /^[0-9]+$/.test(v)
            ? BigInt(v)
            : v;
    const msg = revive(body.acceptTypedData.message) as Record<string, unknown>;
    msg.dealId = id;
    expect(
      hashTypedData({
        domain: body.acceptTypedData.domain,
        types,
        primaryType: 'DealTerms',
        message: msg,
      }).toLowerCase(),
    ).toBe(d.view.current.termsHash);
  });

  it('accepts only the party’s own wallet signature; a rejection blocks funding', async () => {
    const { server, r, d, id, t } = await app();
    const v = d.view.current;
    const wrong = await server.inject({
      method: 'POST',
      url: `/v1/deals/${id}/sign?t=${t}`,
      payload: {
        version: 1,
        role: 'CLIENT',
        signature: await acceptSig(r.service, v, 'FREELANCER'),
      },
    });
    expect(wrong.statusCode).toBe(409);
    expect(wrong.json().error).toBe('WRONG_SIGNER');
    const ok = await server.inject({
      method: 'POST',
      url: `/v1/deals/${id}/sign?t=${t}`,
      payload: {
        version: 1,
        role: 'CLIENT',
        signature: await acceptSig(r.service, v, 'CLIENT'),
      },
    });
    expect(ok.json().signedCurrent).toEqual({
      CLIENT: true,
      FREELANCER: false,
    });
    const rej = await server.inject({
      method: 'POST',
      url: `/v1/deals/${id}/decline?t=${t}`,
      payload: {
        version: 1,
        role: 'FREELANCER',
        decision: 'REJECT',
        reason: 'price',
        signature: await declineSig(v, 'FREELANCER', 'REJECT', 'price'),
      },
    });
    expect(rej.statusCode).toBe(200);
    expect(rej.json().status).toBe('NEGOTIATING');
    await expect(r.service.fundingCall(id)).rejects.toMatchObject({
      code: 'COUNTERPARTY_REJECTED',
    });
    const garbage = await server.inject({
      method: 'POST',
      url: `/v1/deals/${id}/sign?t=${t}`,
      payload: { version: 1, role: 'CLIENT', signature: 'yes' },
    });
    expect(garbage.statusCode).toBe(400);
  });
});
