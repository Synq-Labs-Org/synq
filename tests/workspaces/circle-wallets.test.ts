import {
  constants,
  generateKeyPairSync,
  privateDecrypt,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { CircleWalletProvisioner } from '@synq/execution-worker/circle-wallets';

describe('G2 Circle provisioning capability — LOCAL_FIXTURE', () => {
  it('does not call Circle without credentials or with production credentials', async () => {
    const transport = vi.fn();
    const absent = new CircleWalletProvisioner({}, transport);
    expect(absent.capability().status).toBe('BLOCKED');
    await expect(
      absent.createWalletSet({
        idempotencyKey: randomUUID(),
        name: 'Workspace wallet',
      }),
    ).rejects.toMatchObject({ code: 'CREDENTIALS_REQUIRED' });
    const production = new CircleWalletProvisioner(
      {
        apiKey: `LIVE_API_KEY:${randomUUID()}:${randomBytes(32).toString('hex')}`,
        appId: randomUUID(),
        entitySecret: randomBytes(32).toString('hex'),
      },
      transport,
    );
    await expect(
      production.createWalletSet({
        idempotencyKey: randomUUID(),
        name: 'Workspace wallet',
      }),
    ).rejects.toMatchObject({ code: 'TESTNET_CREDENTIALS_REQUIRED' });
    expect(transport).not.toHaveBeenCalled();
  });
  it('encrypts the entity secret freshly per request and requests only Arc testnet', async () => {
    const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const publicKey = keys.publicKey
      .export({ type: 'spki', format: 'pem' })
      .toString();
    const secret = randomBytes(32).toString('hex');
    const walletSetId = randomUUID();
    const walletId = randomUUID();
    const bodies: Record<string, unknown>[] = [];
    const transport = vi.fn<typeof fetch>(async (url, options) => {
      if (String(url).endsWith('/config/entity/publicKey'))
        return Response.json({ data: { publicKey } });
      const body = JSON.parse(String(options?.body)) as Record<string, unknown>;
      bodies.push(body);
      if (String(url).endsWith('/developer/walletSets'))
        return Response.json({
          data: { walletSet: { id: walletSetId, custodyType: 'DEVELOPER' } },
        });
      return Response.json({
        data: {
          wallets: [
            {
              id: walletId,
              address: `0x${'2'.repeat(40)}`,
              blockchain: 'ARC-TESTNET',
              accountType: 'EOA',
              walletSetId,
              custodyType: 'DEVELOPER',
              state: 'LIVE',
            },
          ],
        },
      });
    });
    const adapter = new CircleWalletProvisioner(
      {
        apiKey: `TEST_API_KEY:${randomUUID()}:${randomBytes(32).toString('hex')}`,
        appId: randomUUID(),
        entitySecret: secret,
      },
      transport,
    );
    expect(adapter.capability().status).toBe('CONFIGURED_NOT_PROVEN');
    await adapter.createWalletSet({
      idempotencyKey: randomUUID(),
      name: 'Workspace wallet',
    });
    const wallet = await adapter.createWallet({
      idempotencyKey: randomUUID(),
      walletSetId,
      name: 'Owner wallet',
    });
    expect(wallet).toMatchObject({
      chainId: 5042002,
      custody: 'DEVELOPER',
      mode: 'PROVIDER_SANDBOX',
    });
    expect(bodies[1]).toMatchObject({
      blockchains: ['ARC-TESTNET'],
      accountType: 'EOA',
      count: 1,
    });
    expect(bodies[0]?.entitySecretCiphertext).not.toBe(
      bodies[1]?.entitySecretCiphertext,
    );
    for (const body of bodies) {
      const decoded = privateDecrypt(
        {
          key: keys.privateKey,
          padding: constants.RSA_PKCS1_OAEP_PADDING,
          oaepHash: 'sha256',
        },
        Buffer.from(String(body.entitySecretCiphertext), 'base64'),
      );
      expect(decoded.toString('hex')).toBe(secret);
      expect(body).not.toHaveProperty('entitySecret');
    }
  });
});
