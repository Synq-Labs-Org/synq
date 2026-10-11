import { createPublicKey, verify } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { hashTypedData, recoverTypedDataAddress } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { perplNetwork } from '@synq/chain-registry';
import { EnrollPayloadSchema, type FetchLike } from '@synq/plugin-perpl';
import {
  enrollApiKey,
  ed25519FromSeed,
  loadPerplKey,
  popDigest,
  typedDataForSigning,
  writePerplKey,
} from '@synq/perpl-executor';

const testnet = perplNetwork('sandbox/monad-testnet');
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'synq-perpl-keys-'));
  dirs.push(d);
  return d;
};
const seedHex = Buffer.alloc(32, 5).toString('hex');
const keyFile = (over: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  apiKey: 'fixture-api-key-token',
  privateKey: seedHex,
  scope: 'trade',
  chainId: testnet.chainId,
  address: `0x${'6'.repeat(40)}`,
  label: 'fixture',
  ...over,
});

describe('Perpl key files', () => {
  it('loads a mode-600 key into a signer closure that never exposes the key', async () => {
    const path = join(tmp(), 'trade.key');
    writePerplKey(path, keyFile() as never);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const loaded = loadPerplKey(path, {
      scope: 'trade',
      chainId: testnet.chainId,
    });
    expect(Object.keys(loaded.signer).sort()).toEqual([
      'apiKey',
      'scope',
      'sign',
    ]);
    const message = new TextEncoder().encode('hello');
    const sig = await loaded.signer.sign(message);
    const pub = createPublicKey(ed25519FromSeed(Buffer.from(seedHex, 'hex')));
    expect(verify(null, message, pub, sig)).toBe(true);
    expect(() => writePerplKey(path, keyFile() as never)).toThrow();
  });

  it('refuses world-readable files, scope or chain mismatches and mismatched public keys', () => {
    const d = tmp();
    const write = (name: string, body: unknown, mode = 0o600) => {
      const p = join(d, name);
      writeFileSync(p, JSON.stringify(body));
      chmodSync(p, mode);
      return p;
    };
    expect(() =>
      loadPerplKey(write('a.key', keyFile(), 0o644), {
        scope: 'trade',
        chainId: testnet.chainId,
      }),
    ).toThrow(/KEY_FILE_PERMISSIONS/);
    expect(() =>
      loadPerplKey(write('b.key', keyFile({ scope: 'read' })), {
        scope: 'trade',
        chainId: testnet.chainId,
      }),
    ).toThrow(/KEY_SCOPE/);
    expect(() =>
      loadPerplKey(write('c.key', keyFile({ chainId: 143 })), {
        scope: 'trade',
        chainId: testnet.chainId,
      }),
    ).toThrow(/KEY_NETWORK/);
    expect(() =>
      loadPerplKey(
        write('d.key', keyFile({ publicKey: `0x${'0'.repeat(64)}` })),
        { scope: 'trade', chainId: testnet.chainId },
      ),
    ).toThrow(/KEY_FILE_INVALID/);
    expect(() =>
      loadPerplKey(join(d, 'missing.key'), {
        scope: 'trade',
        chainId: testnet.chainId,
      }),
    ).toThrow(/KEY_FILE_MISSING/);
  });
});

// Shape captured from the live testnet payload endpoint on 2026-10-10.
const payload = (address: string, publicKey: string) => ({
  typed_data: {
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
        { name: 'salt', type: 'bytes32' },
      ],
      PerplRegisterApiKey: [
        { name: 'signer', type: 'address' },
        { name: 'statement', type: 'string' },
        { name: 'publicKey', type: 'string' },
        { name: 'scope', type: 'string' },
        { name: 'label', type: 'string' },
        { name: 'expiresAt', type: 'string' },
        { name: 'ipCidrs', type: 'string' },
        { name: 'origin', type: 'string' },
        { name: 'builderId', type: 'string' },
        { name: 'maxBuilderFeePer100K', type: 'string' },
        { name: 'time', type: 'uint64' },
      ],
    },
    primaryType: 'PerplRegisterApiKey',
    domain: {
      name: 'perpl.xyz',
      version: '1',
      chainId: '0x279f',
      verifyingContract: `0x${'0'.repeat(40)}`,
      salt: `0x${'0'.repeat(40)}${'ab'.repeat(12)}`,
    },
    message: {
      builderId: '0',
      expiresAt: '0',
      ipCidrs: '',
      label: 'synq-test',
      maxBuilderFeePer100K: '0',
      origin: '',
      publicKey: Buffer.from(publicKey.slice(2), 'hex').toString('base64url'),
      scope: '1',
      signer: address,
      statement:
        'I authorize the creation of Perpl API key with the specified scope and parameters',
      time: '0x1a12656117d',
    },
  },
  mac: `0x${'cd'.repeat(32)}`,
});

describe('programmatic API-key enrollment', () => {
  it('signs the EIP-712 payload with the wallet and proves possession of the Ed25519 key over the same digest', async () => {
    const wallet = privateKeyToAccount(generatePrivateKey());
    let registered: string | null = null;
    const headers: Record<string, string>[] = [];
    const fetcher: FetchLike = async (url, init) => {
      headers.push(init.headers);
      const body = JSON.parse(init.body ?? '{}') as Record<string, unknown>;
      const respond = (status: number, value: unknown) => ({
        status,
        headers: { get: () => null },
        text: async () => JSON.stringify(value),
      });
      if (url.endsWith('/v1/api-key/payload')) {
        registered = body.public_key as string;
        return respond(200, payload(wallet.address, registered));
      }
      const td = EnrollPayloadSchema.parse({
        typed_data: body.typed_data,
        mac: body.mac,
      });
      const definition = typedDataForSigning(td);
      const signer = await recoverTypedDataAddress({
        ...definition,
        signature: body.signature as `0x${string}`,
      } as never);
      const pubDer = Buffer.concat([
        Buffer.from('302a300506032b6570032100', 'hex'),
        Buffer.from(registered!.slice(2), 'hex'),
      ]);
      const popOk = verify(
        null,
        Buffer.from(hashTypedData(definition).slice(2), 'hex'),
        createPublicKey({ key: pubDer, format: 'der', type: 'spki' }),
        Buffer.from((body.pop_signature as string).slice(2), 'hex'),
      );
      if (signer !== wallet.address || !popOk)
        return respond(401, { error: 'bad signature' });
      return respond(200, {
        api_key: {
          api_key: 'opaque-token',
          address: wallet.address,
          scope_mask: 1,
          label: 'synq-test',
          origin: '',
        },
      });
    };
    const keyPath = join(tmp(), 'read.key');
    const result = await enrollApiKey({
      network: testnet,
      address: wallet.address,
      scope: 'read',
      label: 'synq-test',
      signTypedData: (d) => wallet.signTypedData(d as never),
      keyPath,
      fetch: fetcher,
    });
    expect(result).toMatchObject({
      scopeMask: 1,
      origin: '',
      publicKey: registered,
    });
    expect(headers.every((h) => !('Origin' in h) && !('origin' in h))).toBe(
      true,
    );
    const loaded = loadPerplKey(keyPath, {
      scope: 'read',
      chainId: testnet.chainId,
    });
    expect(loaded.signer.apiKey).toBe('opaque-token');
    expect(loaded.publicKey).toBe(registered);
    expect(
      popDigest(
        EnrollPayloadSchema.parse(payload(wallet.address, registered!)),
      ),
    ).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('surfaces an Origin whitelist refusal without writing a key file', async () => {
    const fetcher: FetchLike = async () => ({
      status: 403,
      headers: { get: () => null },
      text: async () => '{"error":"origin not allowed"}',
    });
    const keyPath = join(tmp(), 'trade.key');
    await expect(
      enrollApiKey({
        network: testnet,
        address: `0x${'6'.repeat(40)}`,
        scope: 'trade',
        label: 'x',
        signTypedData: async () => '0x',
        keyPath,
        fetch: fetcher,
      }),
    ).rejects.toMatchObject({ code: 'ORIGIN_NOT_WHITELISTED', status: 403 });
    expect(existsSync(keyPath)).toBe(false);
  });
});
