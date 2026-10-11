import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { perplNetwork } from '@synq/chain-registry';
import {
  PerplRestClient,
  signRestRequest,
  type PerplRequestSigner,
} from '@synq/plugin-perpl';
import {
  defaultKeyPath,
  keyFileExists,
  loadPerplKey,
} from '@synq/perpl-executor';
import { LIVE, recordEvidence } from './evidence.js';

const network = perplNetwork('sandbox/monad-testnet');
const HAVE_KEYS =
  keyFileExists(defaultKeyPath('read')) &&
  keyFileExists(defaultKeyPath('trade'));

async function raw(
  signer: PerplRequestSigner,
  method: 'GET' | 'POST',
  target: string,
  body = '',
  override: { timestamp?: number; nonce?: string; tamper?: boolean } = {},
) {
  const timestamp = override.timestamp ?? Date.now();
  const nonce = override.nonce ?? randomBytes(16).toString('base64url');
  const headers: Record<string, string> = {
    ...(await signRestRequest(signer, {
      chainId: network.chainId,
      method,
      target,
      timestamp,
      nonce,
      body,
    })),
    ...(body ? { 'Content-Type': 'application/json' } : {}),
  };
  if (override.tamper) {
    const sig = Buffer.from(headers['X-API-Signature']!, 'base64url');
    sig[0] = sig[0]! ^ 0xff;
    headers['X-API-Signature'] = sig.toString('base64url');
  }
  const res = await fetch(`${network.restUrl}${target}`, {
    method,
    headers,
    ...(body ? { body } : {}),
  });
  return {
    status: res.status,
    body: (await res.text()).slice(0, 300),
    nonce,
    timestamp,
  };
}

describe.skipIf(!LIVE || !HAVE_KEYS)(
  'REAL_TESTNET Perpl API-key auth and scopes',
  () => {
    const read = () =>
      loadPerplKey(defaultKeyPath('read'), {
        scope: 'read',
        chainId: network.chainId,
      });
    const trade = () =>
      loadPerplKey(defaultKeyPath('trade'), {
        scope: 'trade',
        chainId: network.chainId,
      });

    it('signs reads, rejects stale timestamps, replayed nonces and bad signatures, and enforces scopes', async () => {
      const r = read();
      const t = trade();
      const rest = new PerplRestClient({ network, signer: r.signer });
      const wallet = await rest.wallet();
      const account = wallet.as?.[0];
      expect(account?.fw).toBe(true);

      const ok = await raw(r.signer, 'GET', '/v1/trading/wallet');
      const replay = await raw(r.signer, 'GET', '/v1/trading/wallet', '', {
        nonce: ok.nonce,
        timestamp: ok.timestamp,
      });
      const stale = await raw(r.signer, 'GET', '/v1/trading/wallet', '', {
        timestamp: Date.now() - 120_000,
      });
      const future = await raw(r.signer, 'GET', '/v1/trading/wallet', '', {
        timestamp: Date.now() + 120_000,
      });
      const tampered = await raw(r.signer, 'GET', '/v1/trading/wallet', '', {
        tamper: true,
      });
      expect(ok.status).toBe(200);
      expect(replay.status).toBe(401);
      expect(stale.status).toBe(401);
      expect(future.status).toBe(401);
      expect(tampered.status).toBe(401);

      // A read-scoped key is refused before the body is read.
      const order = JSON.stringify({
        d: [
          {
            rq: (account?.lfr ?? 0) + 1,
            mkt: 64,
            acc: account?.id ?? 0,
            t: 2,
            p: 1,
            s: 1,
            fl: 1,
            lv: 100,
            lb: 0,
          },
        ],
      });
      const readTrade = await raw(
        r.signer,
        'POST',
        '/v1/trading/orders',
        order,
      );
      expect(readTrade.status).toBe(403);

      // No API route moves collateral out: every constructed withdraw/transfer
      // attempt with the trade key is refused.
      const attempts: Record<string, number> = {};
      const amount = JSON.stringify({
        amount: '1000000',
        acc: account?.id,
        to: wallet.addr,
      });
      for (const target of [
        '/v1/trading/withdraw',
        '/v1/trading/withdrawals',
        '/v1/trading/transfer',
        '/v1/trading/transfers',
        '/v1/account/withdraw',
        '/v1/wallet/withdraw',
        '/v1/trading/collateral/withdraw',
      ]) {
        const res = await raw(t.signer, 'POST', target, amount);
        attempts[target] = res.status;
        expect(
          res.status === 404 ||
            res.status === 405 ||
            res.status === 403 ||
            res.status === 400,
        ).toBe(true);
      }
      // Order types outside 1-7 do not exist; a forged "withdraw" order type is refused.
      const forged = JSON.stringify({
        d: [
          {
            rq: (account?.lfr ?? 0) + 1,
            mkt: 64,
            acc: account?.id ?? 0,
            t: 99,
            s: 1,
            a: '1000000',
            fl: 0,
            lv: 0,
            lb: 0,
          },
        ],
      });
      const forgedRes = await raw(
        t.signer,
        'POST',
        '/v1/trading/orders',
        forged,
      );
      const forgedBody =
        forgedRes.status === 200
          ? (JSON.parse(forgedRes.body) as {
              statuses?: { code: number; error?: string }[];
            })
          : null;
      expect(
        forgedRes.status !== 200 ||
          (forgedBody?.statuses?.[0]?.code ?? 0) !== 0,
      ).toBe(true);

      recordEvidence('testnet-auth-scopes', 'REAL_TESTNET', {
        walletAddress: wallet.addr,
        accounts: wallet.as?.map((a) => ({
          id: a.id,
          fw: a.fw,
          frozen: a.fr,
          lfr: a.lfr,
          balance: a.b,
          locked: a.lb,
        })),
        readKeyPublicKey: r.publicKey,
        tradeKeyPublicKey: t.publicKey,
        signedRead: ok.status,
        nonceReplay: replay.status,
        staleTimestamp: stale.status,
        futureTimestamp: future.status,
        tamperedSignature: tampered.status,
        readKeyOrderAttempt: { status: readTrade.status, body: readTrade.body },
        tradeKeyWithdrawTransferAttempts: attempts,
        forgedOrderType99: { status: forgedRes.status, body: forgedRes.body },
      });
    });
  },
);
