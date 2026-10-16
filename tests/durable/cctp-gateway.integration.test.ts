import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import {
  encodeAbiParameters,
  encodeEventTopics,
  erc20Abi,
  hexToString,
  keccak256,
  pad,
  slice,
  stringToHex,
  zeroAddress,
  type Address,
  type Hex,
  type Log,
  type PublicClient,
} from 'viem';
import { contract, token } from '@synq/chain-registry/arc';
import { advance, decodeMessage, planTransfer } from '@synq/plugin-circle-cctp';
import { connectChain } from '@synq/execution-worker/arc';
import { MESSAGE_RECEIVED_EVENT } from '@synq/execution-worker/cctp';
import {
  advanceCctpSaga,
  type CctpSagaStore,
} from '@synq/execution-worker/cctp-saga';
import {
  GatewayLedgerError,
  PostgresCctpSagaStore,
  PostgresGatewayLedger,
} from '@synq/execution-worker/pg-cctp-gateway';
import { migrateExecution } from '@synq/execution-worker/pg-schema';
import { durablePool, runId } from './pg.js';

const fixture = JSON.parse(
  readFileSync(
    new URL('../arc/fixtures/cctp-sepolia-arc-message.json', import.meta.url),
    'utf8',
  ),
) as { message: Hex };
const codes = JSON.parse(
  readFileSync(new URL('./fixtures/cctp-codes.json', import.meta.url), 'utf8'),
) as Record<string, { address: Address; code: Hex }>;
const m = decodeMessage(fixture.message);
const payer = m.burn.messageSender;
const recipient = m.burn.mintRecipient;
const minter = '0x00000000000000000000000000000000000000d1' as Address;
const transmitter = contract(
  'arc-testnet',
  'CCTP_MESSAGE_TRANSMITTER_V2',
).address;
const ARC_USDC = token('arc-testnet', 'USDC').address;
let pool: pg.Pool;

/** Fake signer: the "raw transaction" is the JSON of what it signed, so the fake chain can read it. */
const fakeSigner = (address: Address, counter: { n: number }) => ({
  address,
  signTransaction: async (tx: {
    nonce?: number;
    to?: Address | null;
    data?: Hex;
  }) => {
    counter.n++;
    return stringToHex(
      JSON.stringify({
        from: address,
        nonce: tx.nonce,
        to: tx.to,
        data: tx.data,
      }),
    );
  },
});

type Sent = { from: Address; nonce: number; to: Address; data: Hex; hash: Hex };
function fakeNetwork(
  chainId: number,
  codeByAddress: Record<string, Hex>,
  opts: {
    mintReceipt?: (s: Sent) => Log[];
  } = {},
) {
  // Each fake network starts senders at a fresh nonce: (chain, sender, nonce) is unique forever.
  const base = Math.floor(Math.random() * 1e9);
  const nonces = new Map<string, number>();
  const mined = new Map<Hex, Sent>();
  const broadcasts: Hex[] = [];
  let usedNonce = 0n;
  const extraLogs: Log[] = [];
  const client = {
    getChainId: async () => chainId,
    getCode: async ({ address }: { address: Address }) =>
      codeByAddress[address.toLowerCase()],
    readContract: async ({ functionName }: { functionName: string }) =>
      functionName === 'allowance'
        ? 0n
        : functionName === 'usedNonces'
          ? usedNonce
          : 0n,
    estimateGas: async () => 100_000n,
    estimateFeesPerGas: async () => ({
      maxFeePerGas: 30_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
    }),
    getTransactionCount: async ({ address }: { address: Address }) =>
      nonces.get(address.toLowerCase()) ?? base,
    sendRawTransaction: async ({
      serializedTransaction,
    }: {
      serializedTransaction: Hex;
    }) => {
      broadcasts.push(serializedTransaction);
      const hash = keccak256(serializedTransaction);
      if (mined.has(hash)) throw new Error('already known');
      const s = JSON.parse(hexToString(serializedTransaction)) as Omit<
        Sent,
        'hash'
      >;
      const cur = nonces.get(s.from.toLowerCase()) ?? base;
      if (s.nonce !== cur) throw new Error('nonce too low');
      nonces.set(s.from.toLowerCase(), cur + 1);
      mined.set(hash, { ...s, hash });
      if (opts.mintReceipt && s.to.toLowerCase() === transmitter.toLowerCase())
        usedNonce = 1n;
      return hash;
    },
    getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
      const s = mined.get(hash);
      if (!s) throw new Error('receipt not found');
      return {
        status: 'success',
        to: s.to,
        from: s.from,
        blockNumber: 100n,
        gasUsed: 100_000n,
        effectiveGasPrice: 25_000_000_000n,
        logs: opts.mintReceipt ? opts.mintReceipt(s) : [],
      };
    },
    waitForTransactionReceipt: async ({ hash }: { hash: Hex }) =>
      client.getTransactionReceipt({ hash }),
    getBlockNumber: async () => 1_000n,
    getLogs: async () => extraLogs,
  };
  return {
    client: client as unknown as PublicClient,
    mined,
    broadcasts,
    bumpNonce: (a: Address) =>
      nonces.set(a.toLowerCase(), (nonces.get(a.toLowerCase()) ?? base) + 1),
    thirdPartyMint: (txHash: Hex) => {
      usedNonce = 1n;
      extraLogs.push(receivedLog(txHash));
      mined.set(txHash, {
        from: zeroAddress,
        nonce: 0,
        to: transmitter,
        data: '0x',
        hash: txHash,
      });
    },
  };
}

const receivedLog = (txHash: Hex): Log =>
  ({
    address: transmitter,
    topics: encodeEventTopics({
      abi: [MESSAGE_RECEIVED_EVENT],
      eventName: 'MessageReceived',
      args: {
        caller: minter,
        nonce: m.nonce,
        finalityThresholdExecuted: m.finalityThresholdExecuted,
      },
    }) as Hex[],
    data: encodeAbiParameters(
      [{ type: 'uint32' }, { type: 'bytes32' }, { type: 'bytes' }],
      [m.sourceDomain, pad(m.sender), slice(fixture.message, 148)],
    ),
    logIndex: 1,
    blockNumber: 100n,
    blockHash: `0x${'11'.repeat(32)}`,
    transactionHash: txHash,
    transactionIndex: 0,
    removed: false,
  }) as unknown as Log;
const mintLogs = (s: { hash: Hex }): Log[] => [
  {
    address: ARC_USDC,
    topics: encodeEventTopics({
      abi: erc20Abi,
      eventName: 'Transfer',
      args: { from: zeroAddress, to: recipient },
    }) as Hex[],
    data: encodeAbiParameters(
      [{ type: 'uint256' }],
      [m.burn.amount - m.burn.feeExecuted],
    ),
    logIndex: 0,
    blockNumber: 100n,
    blockHash: `0x${'11'.repeat(32)}`,
    transactionHash: s.hash,
    transactionIndex: 0,
    removed: false,
  } as unknown as Log,
  receivedLog(s.hash),
];

const codeMap = (...keys: string[]) =>
  Object.fromEntries(
    keys.map((k) => [codes[k]!.address.toLowerCase(), codes[k]!.code]),
  );

async function setup(store: CctpSagaStore) {
  const id = `cctp_${runId()}`;
  const planned = planTransfer({
    transferId: id,
    source: 'eth-sepolia',
    destination: 'arc-testnet',
    payer,
    payerKind: 'EOA',
    recipient,
    amount: m.burn.amount,
    maxFee: m.burn.maxFee,
    fast: true,
    reference: m.burn.hookData,
    at: 1,
  });
  await store.create(advance(planned, 'APPROVED', 2, 'payer approved'), 2);
  const src = fakeNetwork(
    11155111,
    codeMap('eth-sepolia:USDC', 'eth-sepolia:CCTP_TOKEN_MESSENGER_V2'),
  );
  const dst = fakeNetwork(
    5042002,
    codeMap('arc-testnet:CCTP_MESSAGE_TRANSMITTER_V2'),
    { mintReceipt: mintLogs },
  );
  return {
    id,
    src,
    dst,
    source: await connectChain('eth-sepolia', undefined, src.client),
    destination: await connectChain('arc-testnet', undefined, dst.client),
  };
}
let clock = 10;
const now = () => clock++;
const attested = async () => ({
  status: 'complete',
  message: fixture.message,
  attestation: '0x01' as Hex,
});
const pendingIris = async () => ({
  status: 'pending_confirmations',
  message: null,
  attestation: null,
});

beforeAll(async () => {
  pool = await durablePool();
  await migrateExecution(pool);
});
afterAll(async () => {
  await pool.end();
});

describe('CCTP saga on Postgres', { timeout: 60_000 }, () => {
  it('crash after the burn is recorded and again after the mint is recorded: one burn, one mint, reconciled', async () => {
    const s = await setup(new PostgresCctpSagaStore(pool));
    const signs = { n: 0 };
    const base = {
      transferId: s.id,
      source: s.source,
      destination: s.destination,
      payer: fakeSigner(payer, signs),
      minter: fakeSigner(minter, signs),
      now,
    };
    await expect(
      advanceCctpSaga({
        ...base,
        store: new PostgresCctpSagaStore(pool),
        attestation: attested,
        afterRecord: (leg) => {
          if (leg === 'BURN') throw new Error('killed after burn record');
        },
      }),
    ).rejects.toThrow(/killed/);
    // Approve went out; the burn is recorded but never broadcast.
    expect(s.src.mined.size).toBe(1);
    const waiting = await advanceCctpSaga({
      ...base,
      store: new PostgresCctpSagaStore(pool),
      attestation: pendingIris,
    });
    expect(waiting).toMatchObject({ waiting: 'ATTESTATION' });
    expect(s.src.mined.size).toBe(2); // approve + the recorded burn, resent as-is
    expect(signs.n).toBe(2);
    await expect(
      advanceCctpSaga({
        ...base,
        store: new PostgresCctpSagaStore(pool),
        attestation: attested,
        afterRecord: (leg) => {
          if (leg === 'MINT') throw new Error('killed after mint record');
        },
      }),
    ).rejects.toThrow(/killed/);
    expect(s.dst.mined.size).toBe(0);
    const done = await advanceCctpSaga({
      ...base,
      store: new PostgresCctpSagaStore(pool),
      attestation: attested,
    });
    expect(done.transfer.state).toBe('DEST_FINAL');
    expect(done.transfer.minted).toBe(m.burn.amount - m.burn.feeExecuted);
    expect(s.dst.mined.size).toBe(1);
    expect(signs.n).toBe(3);
    // Re-running a finished saga signs and sends nothing.
    await advanceCctpSaga({
      ...base,
      store: new PostgresCctpSagaStore(pool),
      attestation: attested,
    });
    expect(signs.n).toBe(3);
    expect(s.src.mined.size + s.dst.mined.size).toBe(3);
  });

  it('two workers racing a fresh saga broadcast one burn; a consumed burn nonce stops in review without burning again', async () => {
    const s = await setup(new PostgresCctpSagaStore(pool));
    const signs = { n: 0 };
    const run = () =>
      advanceCctpSaga({
        store: new PostgresCctpSagaStore(pool),
        transferId: s.id,
        source: s.source,
        destination: s.destination,
        payer: fakeSigner(payer, signs),
        minter: fakeSigner(minter, signs),
        attestation: pendingIris,
        now,
      });
    await Promise.allSettled([run(), run()]);
    const burns = [...s.src.mined.values()].filter(
      (x) =>
        x.to.toLowerCase() ===
        contract(
          'eth-sepolia',
          'CCTP_TOKEN_MESSENGER_V2',
        ).address.toLowerCase(),
    );
    expect(burns).toHaveLength(1);

    const t = await setup(new PostgresCctpSagaStore(pool));
    await expect(
      advanceCctpSaga({
        store: new PostgresCctpSagaStore(pool),
        transferId: t.id,
        source: t.source,
        destination: t.destination,
        payer: fakeSigner(payer, signs),
        minter: fakeSigner(minter, signs),
        attestation: pendingIris,
        now,
        afterRecord: (leg) => {
          if (leg === 'BURN') throw new Error('killed');
        },
      }),
    ).rejects.toThrow();
    t.src.bumpNonce(payer); // another transaction used the burn's nonce
    const r = await advanceCctpSaga({
      store: new PostgresCctpSagaStore(pool),
      transferId: t.id,
      source: t.source,
      destination: t.destination,
      payer: fakeSigner(payer, signs),
      minter: fakeSigner(minter, signs),
      attestation: pendingIris,
      now,
    });
    expect(r.waiting).toBe('REVIEW');
    expect(
      [...t.src.mined.values()].filter(
        (x) =>
          x.to.toLowerCase() !==
          token('eth-sepolia', 'USDC').address.toLowerCase(),
      ),
    ).toHaveLength(0);
  });

  it('a message minted by a third party is reconciled from its MessageReceived, never minted again', async () => {
    const s = await setup(new PostgresCctpSagaStore(pool));
    const signs = { n: 0 };
    const relayed = keccak256(stringToHex(`relayer-mint-${s.id}`));
    s.dst.thirdPartyMint(relayed);
    const done = await advanceCctpSaga({
      store: new PostgresCctpSagaStore(pool),
      transferId: s.id,
      source: s.source,
      destination: s.destination,
      payer: fakeSigner(payer, signs),
      minter: fakeSigner(minter, signs),
      attestation: attested,
      now,
    });
    expect(done.transfer).toMatchObject({
      state: 'DEST_FINAL',
      mintTx: relayed,
    });
    expect(s.dst.broadcasts).toHaveLength(0);
  });
});

describe('Gateway buckets on Postgres', { timeout: 60_000 }, () => {
  it('a deposit is credited once across restarts; a burn intent salt is spent once and never resubmitted after a crash', async () => {
    const acct = `gw_${runId()}`;
    const a = new PostgresGatewayLedger(pool);
    await a.open(acct, 1_000_000n, 1);
    const dep = {
      chainId: 11155111,
      txHash: keccak256(stringToHex(`dep-${acct}`)),
      amount: 600_000n,
    };
    const results = await Promise.all(
      [1, 2, 3, 4].map(() =>
        new PostgresGatewayLedger(pool).deposit(acct, dep, 2),
      ),
    );
    expect(results.filter((r) => r === 'CREDITED')).toHaveLength(1);
    expect(await new PostgresGatewayLedger(pool).buckets(acct)).toEqual({
      sourceFree: 400_000n,
      pending: 600_000n,
      available: 0n,
      reserved: 0n,
    });
    // Pending is not spendable until Gateway reports it available.
    const salt = keccak256(stringToHex(`salt-${acct}`));
    await expect(
      a.reserve(
        acct,
        { salt, value: 100_000n, intent: { v: 1n }, signature: '0x01' },
        3,
      ),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_AVAILABLE' });
    await a.observeAvailable(acct, 600_000n, 4);
    await a.reserve(
      acct,
      { salt, value: 100_000n, intent: { v: 1n }, signature: '0x01' },
      5,
    );
    await expect(
      new PostgresGatewayLedger(pool).reserve(
        acct,
        { salt, value: 100_000n, intent: {}, signature: '0x01' },
        6,
      ),
    ).rejects.toBeInstanceOf(GatewayLedgerError);
    // Crash inside the API call after the intent was marked SUBMITTED.
    let sends = 0;
    await expect(
      a.submitOnce(
        salt,
        async () => {
          sends++;
          throw new Error('process died during POST /v1/transfer');
        },
        () => 7,
      ),
    ).rejects.toThrow(/died/);
    const after = await new PostgresGatewayLedger(pool).submitOnce(
      salt,
      async () => {
        sends++;
        return { attestation: '0xaa', signature: '0xbb' };
      },
      () => 8,
    );
    expect(after).toEqual({ outcome: 'NEEDS_REVIEW', state: 'SUBMITTED' });
    expect(sends).toBe(1);
    // A clean intent attests once; later calls return the recorded attestation without sending.
    const salt2 = keccak256(stringToHex(`salt2-${acct}`));
    await a.reserve(
      acct,
      { salt: salt2, value: 50_000n, intent: {}, signature: '0x01' },
      9,
    );
    const first = await a.submitOnce(
      salt2,
      async () => (sends++, { attestation: '0xaa', signature: '0xbb' }),
      () => 10,
    );
    const second = await new PostgresGatewayLedger(pool).submitOnce(
      salt2,
      async () => (sends++, { attestation: '0xcc', signature: '0xdd' }),
      () => 11,
    );
    expect(first).toEqual(second);
    expect(sends).toBe(2);
    await a.settle(salt2, keccak256(stringToHex(`mint-${acct}`)), 12);
    await a.settle(salt2, keccak256(stringToHex(`mint-${acct}`)), 13);
    expect(await a.buckets(acct)).toMatchObject({
      available: 450_000n,
      reserved: 100_000n,
    });
  });
});
