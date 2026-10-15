import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  encodeAbiParameters,
  encodeEventTopics,
  erc20Abi,
  pad,
  slice,
  zeroAddress,
  type Address,
  type Hex,
  type Log,
} from 'viem';
import { contract, token } from '@synq/chain-registry/arc';
import { decodeMessage, planTransfer } from '@synq/plugin-circle-cctp';
import {
  MESSAGE_RECEIVED_EVENT,
  reconcileMintReceipt,
  type MintReceipt,
} from '@synq/execution-worker/cctp';

// Real attested Sepolia → Arc message; the receipts around it are synthetic.
const fixture = JSON.parse(
  readFileSync(
    new URL('./fixtures/cctp-sepolia-arc-message.json', import.meta.url),
    'utf8',
  ),
) as { message: Hex };
const m = decodeMessage(fixture.message);
const recipient = m.burn.mintRecipient;
const transmitter = contract('arc-testnet', 'CCTP_MESSAGE_TRANSMITTER_V2')
  .address as Address;
const usdc = token('arc-testnet', 'USDC').address;
const credited = m.burn.amount - m.burn.feeExecuted;
const MINT_TX = `0x${'ab'.repeat(32)}` as Hex;
const other = `0x${'0d'.repeat(20)}` as Address;

const transfer = planTransfer({
  transferId: 'cctp_rc',
  source: 'eth-sepolia',
  destination: 'arc-testnet',
  payer: m.burn.messageSender,
  payerKind: 'EOA',
  recipient,
  amount: m.burn.amount,
  maxFee: m.burn.maxFee,
  fast: true,
  reference: m.burn.hookData,
  at: 1,
});

let index = 0;
const log = (address: Address, topics: Hex[], data: Hex): Log =>
  ({
    address,
    topics,
    data,
    logIndex: index++,
    blockNumber: 100n,
    blockHash: `0x${'11'.repeat(32)}`,
    transactionHash: MINT_TX,
    transactionIndex: 0,
    removed: false,
  }) as unknown as Log;
const received = (over: { nonce?: Hex; domain?: number; body?: Hex } = {}) =>
  log(
    transmitter,
    encodeEventTopics({
      abi: [MESSAGE_RECEIVED_EVENT],
      eventName: 'MessageReceived',
      args: {
        caller: other,
        nonce: over.nonce ?? m.nonce,
        finalityThresholdExecuted: m.finalityThresholdExecuted,
      },
    }) as Hex[],
    encodeAbiParameters(
      [{ type: 'uint32' }, { type: 'bytes32' }, { type: 'bytes' }],
      [
        over.domain ?? m.sourceDomain,
        pad(m.sender),
        over.body ?? slice(fixture.message, 148),
      ],
    ),
  );
const usdcTransfer = (from: Address, to: Address, value: bigint) =>
  log(
    usdc,
    encodeEventTopics({
      abi: erc20Abi,
      eventName: 'Transfer',
      args: { from, to },
    }) as Hex[],
    encodeAbiParameters([{ type: 'uint256' }], [value]),
  );
const receipt = (
  logs: Log[],
  over: Partial<MintReceipt> = {},
): MintReceipt => ({
  status: 'success',
  to: transmitter,
  from: other,
  blockNumber: 100n,
  gasUsed: 176_707n,
  effectiveGasPrice: 25_000_000_000n,
  logs,
  ...over,
});
const reconcile = (r: MintReceipt) =>
  reconcileMintReceipt({
    transfer,
    message: fixture.message,
    receipt: r,
    mintTx: MINT_TX,
    explorer: 'https://explorer.testnet.arc.io/tx/x',
  });

describe('reconcileMint ties the destination receipt to the attested message', () => {
  it('accepts the transmitter call with its MessageReceived and one mint from 0x0', () => {
    const r = reconcile(
      receipt([
        usdcTransfer(zeroAddress, recipient, credited),
        usdcTransfer(zeroAddress, other, m.burn.feeExecuted),
        received(),
      ]),
    );
    expect(r).toMatchObject({
      minted: credited,
      feeExecuted: m.burn.feeExecuted,
      nonce: m.nonce,
      gasPayer: other,
      gasFeeWei: 176_707n * 25_000_000_000n,
    });
  });

  it('refuses a receipt that did not call MessageTransmitterV2', () => {
    expect(() =>
      reconcile(
        receipt([usdcTransfer(zeroAddress, recipient, credited), received()], {
          to: other,
        }),
      ),
    ).toThrow(/not MessageTransmitterV2/);
  });

  it('refuses another message: wrong nonce, wrong source domain or a different body', () => {
    const mint = usdcTransfer(zeroAddress, recipient, credited);
    expect(() =>
      reconcile(receipt([mint, received({ nonce: `0x${'99'.repeat(32)}` })])),
    ).toThrow(/MessageReceived/);
    expect(() => reconcile(receipt([mint, received({ domain: 6 })]))).toThrow(
      /MessageReceived/,
    );
    expect(() =>
      reconcile(receipt([mint, received({ body: '0x1234' })])),
    ).toThrow(/MessageReceived/);
  });

  it('refuses a USDC credit that is not a mint (not from 0x0)', () => {
    expect(() =>
      reconcile(
        receipt([usdcTransfer(other, recipient, credited), received()]),
      ),
    ).toThrow(/from 0x0/);
  });

  it('refuses a plain transfer paying the recipient with no attested message', () => {
    expect(() =>
      reconcile(
        receipt([usdcTransfer(other, recipient, credited)], { to: usdc }),
      ),
    ).toThrow(/not MessageTransmitterV2/);
    expect(() =>
      reconcile(
        receipt([usdcTransfer(zeroAddress, recipient, credited)], {
          to: transmitter,
        }),
      ),
    ).toThrow(/0 MessageReceived/);
  });

  it('refuses a reverted receipt and a wrong amount', () => {
    expect(() =>
      reconcile(
        receipt([usdcTransfer(zeroAddress, recipient, credited), received()], {
          status: 'reverted',
        }),
      ),
    ).toThrow(expect.objectContaining({ code: 'RECEIPT_FAILED' }));
    expect(() =>
      reconcile(
        receipt([
          usdcTransfer(zeroAddress, recipient, credited - 1n),
          received(),
        ]),
      ),
    ).toThrow(/from 0x0/);
  });
});
