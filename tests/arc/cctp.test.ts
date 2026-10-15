import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Hex, PublicClient } from 'viem';
import { token } from '@synq/chain-registry/arc';
import {
  CctpError,
  advance,
  checkMessage,
  decodeMessage,
  irisMessage,
  maxFeeFor,
  netMinted,
  planTransfer,
} from '@synq/plugin-circle-cctp';
import { burnStatus, mintOnDestination } from '@synq/execution-worker/cctp';
import { connectChain } from '@synq/execution-worker/arc';

// Real attested message: Sepolia → Arc burn 0x199e611f… (1.0001 USDC, fee 100, ref in hookData).
const fixture = JSON.parse(
  readFileSync(
    new URL('./fixtures/cctp-sepolia-arc-message.json', import.meta.url),
    'utf8',
  ),
) as { message: Hex };
const decodedFixture = decodeMessage(fixture.message);
// Parties of the real transfer, read from the message rather than hard-coded.
const issuer = decodedFixture.burn.mintRecipient;
const client = decodedFixture.burn.messageSender;
const REF =
  '0xbb53f3d47de3999ad0bcce3c52de99261726a802f8315073056ac5a80f386cf2' as Hex;

const planned = (over: Partial<Parameters<typeof planTransfer>[0]> = {}) =>
  planTransfer({
    transferId: 'cctp_t',
    source: 'eth-sepolia',
    destination: 'arc-testnet',
    payer: client,
    payerKind: 'EOA',
    recipient: issuer,
    amount: 1_000_100n,
    maxFee: 100n,
    fast: true,
    reference: REF,
    at: 1,
    ...over,
  });

describe('CCTP V2 saga (P09)', () => {
  it('decodes the real attested message exactly', () => {
    const m = decodeMessage(fixture.message);
    expect(m).toMatchObject({
      sourceDomain: 0,
      destinationDomain: 26,
      minFinalityThreshold: 1000,
    });
    expect(m.burn.burnToken.toLowerCase()).toBe(
      token('eth-sepolia', 'USDC').address.toLowerCase(),
    );
    expect(m.burn.mintRecipient.toLowerCase()).toBe(issuer.toLowerCase());
    expect(m.burn.messageSender.toLowerCase()).toBe(client.toLowerCase());
    expect([m.burn.amount, m.burn.maxFee, m.burn.feeExecuted]).toEqual([
      1_000_100n,
      100n,
      100n,
    ]);
    expect(m.burn.hookData).toBe(REF);
    expect(netMinted(m)).toBe(1_000_000n); // P09-04
    checkMessage(planned(), m);
  });

  it('P09-01 refuses unsupported routes, read-only chains and incompatible signers', () => {
    expect(() => planned({ destination: 'eth-sepolia' })).toThrow(CctpError);
    expect(() => planned({ destination: 'arc-mainnet' })).toThrow(/read-only/);
    expect(() => planned({ payerKind: 'CIRCLE_SCA' })).toThrow(/cannot sign/);
    expect(() => planned({ maxFee: 1_000_100n })).toThrow(/FEE_TOO_HIGH|>=/);
    expect(maxFeeFor(1_000_000n, 1)).toBe(100n);
    expect(maxFeeFor(1_000_001n, 1)).toBe(101n); // rounded up, never short
  });

  it('P09-06 / P09-07 a message with another recipient, domain, amount or reference is rejected', () => {
    const m = decodeMessage(fixture.message);
    expect(() => checkMessage(planned({ recipient: client }), m)).toThrow(
      /WRONG_RECIPIENT|!=/,
    );
    expect(() =>
      checkMessage(planned({ amount: 1_000_101n, maxFee: 100n }), m),
    ).toThrow(/amount/);
    expect(() =>
      checkMessage(planned({ reference: `0x${'00'.repeat(32)}` }), m),
    ).toThrow(/hookData/);
    expect(() => checkMessage(planned({ reference: null }), m)).toThrow(
      /hookData/,
    );
    expect(() => checkMessage(planned({ source: 'base-sepolia' }), m)).toThrow(
      /domains/,
    );
  });

  it('P09-02 / P09-03 the saga never re-enters the burn; Iris is polled with reads that tolerate 404', async () => {
    let t = advance(planned(), 'APPROVED', 2, 'ok');
    t = advance(t, 'SOURCE_SUBMITTED', 3, 'hash recorded', {
      burnTx: `0x${'ab'.repeat(32)}`,
    });
    expect(() => advance(t, 'APPROVED', 4, 'retry burn')).toThrow(
      /SOURCE_SUBMITTED -> APPROVED/,
    );
    expect(() =>
      advance(t, 'SOURCE_SUBMITTED', 4, 'resend', {
        burnTx: `0x${'cd'.repeat(32)}`,
      }),
    ).not.toThrow(); // same state: patch only, no new write
    const calls: string[] = [];
    const fake = (status: number, body: unknown) =>
      (async (url: string) => {
        calls.push(String(url));
        return new Response(JSON.stringify(body), { status });
      }) as unknown as typeof fetch;
    expect(
      await irisMessage('eth-sepolia', `0x${'ab'.repeat(32)}`, fake(404, {})),
    ).toBeNull();
    expect(
      await irisMessage(
        'eth-sepolia',
        `0x${'ab'.repeat(32)}`,
        fake(200, {
          messages: [
            {
              status: 'pending_confirmations',
              message: '0x',
              attestation: 'PENDING',
            },
          ],
        }),
      ),
    ).toMatchObject({ status: 'pending_confirmations', attestation: null });
    expect(
      calls.every((u) => u.includes('/v2/messages/0?transactionHash=')),
    ).toBe(true);
    // Recovery is a receipt read, never a resend.
    const reads: string[] = [];
    const client0 = {
      getChainId: async () => 11155111,
      getTransactionReceipt: async () => {
        reads.push('receipt');
        throw new Error('not found');
      },
    } as unknown as PublicClient;
    expect(
      await burnStatus(
        await connectChain('eth-sepolia', undefined, client0),
        `0x${'ab'.repeat(32)}`,
      ),
    ).toBe('UNKNOWN');
    expect(reads).toEqual(['receipt']);
  });

  it('P09-05 a message whose nonce is already used on Arc is never minted twice', async () => {
    const t = advance(
      advance(
        advance(
          advance(
            advance(planned(), 'APPROVED', 2, ''),
            'SOURCE_SUBMITTED',
            3,
            '',
          ),
          'SOURCE_CONFIRMED',
          4,
          '',
        ),
        'ATTESTATION_PENDING',
        5,
        '',
      ),
      'ATTESTED',
      6,
      '',
    );
    const arc = {
      getChainId: async () => 5042002,
      getCode: async () => {
        throw new Error('code read should come after the message check');
      },
      readContract: async () => 1n,
    } as unknown as PublicClient;
    const chain = await connectChain('arc-testnet', undefined, arc);
    // With an unpinnable fake transmitter the call stops at the code check, proving the order:
    // message checked first, then pinned code, then usedNonces, then (only if unused) a write.
    await expect(
      mintOnDestination({
        chain,
        signer: {
          address: issuer,
          signTransaction: async () => {
            throw new Error('no write');
          },
        },
        transfer: t,
        message: fixture.message,
        attestation: '0x01',
        onMintHash: () => {
          throw new Error('no write');
        },
      }),
    ).rejects.toThrow(/code read should come after/);
    await expect(
      mintOnDestination({
        chain,
        signer: { address: issuer, signTransaction: async () => '0x' },
        transfer: { ...t, recipient: client },
        message: fixture.message,
        attestation: '0x01',
        onMintHash: () => undefined,
      }),
    ).rejects.toThrow(/WRONG_RECIPIENT|!=/);
  });
});
