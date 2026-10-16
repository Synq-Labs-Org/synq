import {
  encodeFunctionData,
  erc20Abi,
  parseEventLogs,
  type Address,
  type Hex,
  type Log,
} from 'viem';
import { contract, token, tokenEntry } from '@synq/chain-registry/arc';
import {
  advance,
  checkMessage,
  decodeMessage,
  type CctpTransfer,
  type IrisMessage,
} from '@synq/plugin-circle-cctp';
import {
  ArcExecutionError,
  verifyCode,
  type ArcChain,
  type TransferSigner,
} from './arc.js';
import {
  MESSAGE_RECEIVED_EVENT,
  MESSAGE_TRANSMITTER_V2_ABI,
  burnCalldata,
  reconcileMint,
  settleSignedCall,
  signCall,
  type SignedCall,
} from './cctp.js';

/**
 * Durable CCTP V2 saga: every transaction leg (approve, burn, mint) is signed,
 * then recorded with its raw bytes, and only then broadcast. A restart (or a
 * second worker) resumes from the record: it reads the receipt, or resends the
 * identical bytes, and never signs a second leg of the same kind, so a burn can
 * never happen twice. If a leg's nonce was consumed by another transaction the
 * saga stops in review. The mint is reconciled only against the attested
 * message's MessageReceived event and a mint from 0x0 (`reconcileMint`),
 * including when a third party relayed it first.
 */

export type SagaLeg = 'APPROVE' | 'BURN' | 'MINT';

export type CctpSagaRecord = Readonly<{
  transfer: CctpTransfer;
  rev: number;
  legs: Readonly<Partial<Record<SagaLeg, SignedCall>>>;
  review: string | null;
}>;

export interface CctpSagaStore {
  /** Inserts a planned transfer; false if the id exists. */
  create(t: CctpTransfer, at: number): Promise<boolean>;
  get(transferId: string): Promise<CctpSagaRecord | null>;
  /** Compare-and-set on `rev`; false when another worker saved first. */
  save(t: CctpTransfer, expectedRev: number, at: number): Promise<boolean>;
  /** Records a signed leg once; returns whichever leg is stored (first wins). */
  recordLeg(
    transferId: string,
    leg: SagaLeg,
    signed: SignedCall,
    at: number,
  ): Promise<SignedCall>;
  flagReview(transferId: string, note: string, at: number): Promise<void>;
}

export class MemoryCctpSagaStore implements CctpSagaStore {
  private rows = new Map<
    string,
    {
      transfer: CctpTransfer;
      rev: number;
      legs: Partial<Record<SagaLeg, SignedCall>>;
      review: string | null;
    }
  >();
  async create(t: CctpTransfer) {
    if (this.rows.has(t.transferId)) return false;
    this.rows.set(t.transferId, {
      transfer: t,
      rev: 1,
      legs: {},
      review: null,
    });
    return true;
  }
  async get(id: string) {
    const r = this.rows.get(id);
    return r ? { ...r, legs: { ...r.legs } } : null;
  }
  async save(t: CctpTransfer, expectedRev: number) {
    const r = this.rows.get(t.transferId);
    if (!r || r.rev !== expectedRev) return false;
    r.transfer = t;
    r.rev += 1;
    return true;
  }
  async recordLeg(id: string, leg: SagaLeg, signed: SignedCall) {
    const r = this.rows.get(id)!;
    r.legs[leg] ??= signed;
    return r.legs[leg]!;
  }
  async flagReview(id: string, note: string) {
    this.rows.get(id)!.review = note;
  }
}

export type SagaStepResult = Readonly<{
  transfer: CctpTransfer;
  /** Why the saga paused: waiting for Iris, or stopped for human review. */
  waiting: 'ATTESTATION' | 'REVIEW' | null;
  note: string | null;
}>;

export async function advanceCctpSaga(input: {
  store: CctpSagaStore;
  transferId: string;
  source: ArcChain;
  destination: ArcChain;
  /** The payer's signer on the source chain. */
  payer: TransferSigner;
  /** Any funded signer on the destination that submits the mint. */
  minter: TransferSigner;
  attestation: (burnTx: Hex) => Promise<IrisMessage | null>;
  now: () => number;
  /** Test seam: runs after a leg is durably recorded, before broadcast. */
  afterRecord?: (leg: SagaLeg, s: SignedCall) => Promise<void> | void;
}): Promise<SagaStepResult> {
  const { store, transferId, now } = input;
  let rec = await store.get(transferId);
  if (!rec) throw new ArcExecutionError('TX_MISMATCH', `no saga ${transferId}`);
  if (rec.review)
    return { transfer: rec.transfer, waiting: 'REVIEW', note: rec.review };
  const review = async (note: string): Promise<SagaStepResult> => {
    await store.flagReview(transferId, note, now());
    return { transfer: rec!.transfer, waiting: 'REVIEW', note };
  };
  const move = async (
    state: CctpTransfer['state'],
    note: string,
    patch: Partial<CctpTransfer> = {},
  ) => {
    const next = advance(rec!.transfer, state, now(), note, patch);
    if (!(await store.save(next, rec!.rev, now())))
      throw new ArcExecutionError(
        'TX_MISMATCH',
        `saga ${transferId} advanced concurrently; reload and retry`,
      );
    rec = (await store.get(transferId))!;
  };
  /** Sign once, record, broadcast the recorded bytes; resume from the record. */
  const leg = async (
    name: SagaLeg,
    chain: ArcChain,
    signer: TransferSigner,
    to: Address,
    data: Hex,
  ) => {
    let signed = rec!.legs[name];
    if (!signed) {
      const fresh = await signCall(chain, signer, to, data);
      // First recorder wins; a losing signature is discarded unsent.
      signed = await store.recordLeg(transferId, name, fresh, now());
      await input.afterRecord?.(name, signed);
    }
    return { signed, outcome: await settleSignedCall(chain, signed) };
  };

  const t0 = rec.transfer;
  if (t0.state === 'RECONCILED' || t0.state === 'FAILED')
    return { transfer: t0, waiting: null, note: null };
  if (t0.state === 'QUOTED')
    throw new ArcExecutionError(
      'TX_MISMATCH',
      'saga needs the payer approval (APPROVED) before any burn',
    );

  // Source leg.
  if (['APPROVED', 'SOURCE_SUBMITTED'].includes(rec.transfer.state)) {
    const t = rec.transfer;
    const { source, payer } = input;
    if (source.profile.name !== t.source)
      throw new ArcExecutionError('WRONG_CHAIN', source.profile.name);
    if (payer.address.toLowerCase() !== t.payer.toLowerCase())
      throw new ArcExecutionError('SIGNER_MISMATCH');
    const usdc = token(t.source, 'USDC');
    const messenger = contract(t.source, 'CCTP_TOKEN_MESSENGER_V2');
    await verifyCode(source, usdc.address, tokenEntry(usdc).codeHash);
    await verifyCode(source, messenger.address, messenger.codeHash);
    if (!rec.legs.BURN) {
      const allowance = await source.client.readContract({
        address: usdc.address,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [t.payer, messenger.address],
      });
      if (allowance < t.amount || rec.legs.APPROVE) {
        const a = await leg(
          'APPROVE',
          source,
          payer,
          usdc.address,
          encodeFunctionData({
            abi: erc20Abi,
            functionName: 'approve',
            args: [messenger.address, t.amount],
          }),
        );
        if (a.outcome !== 'SUCCESS')
          return review(`approve ${a.signed.hash}: ${a.outcome}`);
      }
    }
    const b = await leg(
      'BURN',
      source,
      payer,
      messenger.address,
      burnCalldata(t),
    );
    if (rec.transfer.state === 'APPROVED')
      await move('SOURCE_SUBMITTED', 'burn recorded before broadcast', {
        burnTx: b.signed.hash,
      });
    if (b.outcome === 'NONCE_CONSUMED')
      return review(
        `burn nonce ${b.signed.nonce} consumed by another transaction; not burning again`,
      );
    if (b.outcome === 'REVERTED') {
      await move('FAILED', `burn ${b.signed.hash} reverted`);
      return { transfer: rec.transfer, waiting: null, note: 'burn reverted' };
    }
    await move('SOURCE_CONFIRMED', 'burn receipt success');
  }

  // Attestation.
  if (
    ['SOURCE_CONFIRMED', 'ATTESTATION_PENDING'].includes(rec.transfer.state)
  ) {
    const m = await input.attestation(rec.transfer.burnTx!).catch(() => null);
    if (!m?.message || !m.attestation || m.status !== 'complete') {
      if (rec.transfer.state === 'SOURCE_CONFIRMED')
        await move('ATTESTATION_PENDING', 'waiting for Iris');
      return {
        transfer: rec.transfer,
        waiting: 'ATTESTATION',
        note: m?.status ?? null,
      };
    }
    const decoded = decodeMessage(m.message);
    checkMessage(rec.transfer, decoded);
    await move('ATTESTED', 'attestation read', {
      message: m.message,
      attestation: m.attestation,
      nonce: decoded.nonce,
    });
  }

  // Destination leg.
  if (['ATTESTED', 'DEST_SUBMITTED'].includes(rec.transfer.state)) {
    const t = rec.transfer;
    const dst = input.destination;
    if (dst.profile.name !== t.destination)
      throw new ArcExecutionError('WRONG_CHAIN', dst.profile.name);
    const transmitter = contract(t.destination, 'CCTP_MESSAGE_TRANSMITTER_V2');
    await verifyCode(dst, transmitter.address, transmitter.codeHash);
    const used = await dst.client.readContract({
      address: transmitter.address,
      abi: MESSAGE_TRANSMITTER_V2_ABI,
      functionName: 'usedNonces',
      args: [t.nonce!],
    });
    let mintTx: Hex | null = rec.legs.MINT?.hash ?? null;
    if (used !== 0n && !mintTx) {
      // Minted by someone else (a relayer, or us before a crash without a
      // record): find the MessageReceived for this nonce; never mint again.
      mintTx = await findMintTx(dst, transmitter.address, t.nonce!);
      if (!mintTx)
        return review(`nonce ${t.nonce} used but no MessageReceived found`);
    } else if (used === 0n || rec.legs.MINT) {
      const m = await leg(
        'MINT',
        dst,
        input.minter,
        transmitter.address,
        encodeFunctionData({
          abi: MESSAGE_TRANSMITTER_V2_ABI,
          functionName: 'receiveMessage',
          args: [t.message!, t.attestation!],
        }),
      );
      if (m.outcome === 'NONCE_CONSUMED' || m.outcome === 'REVERTED') {
        // Our mint did not land; if the message was minted anyway, find it.
        mintTx = await findMintTx(dst, transmitter.address, t.nonce!);
        if (!mintTx)
          return review(
            `mint ${m.signed.hash}: ${m.outcome}, message not minted`,
          );
      } else mintTx = m.signed.hash;
    }
    if (rec.transfer.state === 'ATTESTED')
      await move('DEST_SUBMITTED', 'mint recorded', { mintTx });
    const r = await reconcileMint(dst, rec.transfer, t.message!, mintTx!);
    await move('DEST_FINAL', 'mint reconciled against MessageReceived', {
      mintTx,
      minted: r.minted,
      feeExecuted: r.feeExecuted,
    });
  }
  return { transfer: rec.transfer, waiting: null, note: null };
}

async function findMintTx(
  chain: ArcChain,
  transmitter: Address,
  nonce: Hex,
): Promise<Hex | null> {
  const head = await chain.client.getBlockNumber();
  // MessageReceived indexes the nonce; scan a bounded recent window.
  const from = head > 200_000n ? head - 200_000n : 0n;
  const logs = await chain.client.getLogs({
    address: transmitter,
    event: MESSAGE_RECEIVED_EVENT,
    args: { nonce },
    fromBlock: from,
    toBlock: head,
  });
  const hit = parseEventLogs({
    abi: [MESSAGE_RECEIVED_EVENT],
    logs: logs as Log[],
  }).find((l) => l.args.nonce.toLowerCase() === nonce.toLowerCase());
  return hit?.transactionHash ?? null;
}
