import { pad, parseAbi, type Address, type Hex, type PublicClient } from 'viem';
import {
  ausdAssets,
  ausdOftNetwork,
  ausdRegistry,
  isMutationEnabledChain,
  type AusdOftConfigured,
} from '@synq/chain-registry';
import type { Asset } from '@synq/domain';
import {
  FundingError,
  contentHash,
  modeForChain,
  type FundingRequest,
  type FundingRouteAdapter,
  type NormalizedQuote,
  type RouteCapability,
  type TokenRef,
} from '@synq/funding';

const SEND_PARAM =
  '(uint32 dstEid, bytes32 to, uint256 amountLD, uint256 minAmountLD, bytes extraOptions, bytes composeMsg, bytes oftCmd)';
export const oftAbi = parseAbi([
  'function token() view returns (address)',
  'function endpoint() view returns (address)',
  'function peers(uint32 eid) view returns (bytes32)',
  'function approvalRequired() view returns (bool)',
  'function sharedDecimals() view returns (uint8)',
  `function quoteOFT(${SEND_PARAM} sendParam) view returns ((uint256 minAmountLD, uint256 maxAmountLD) limit, (int256 feeAmountLD, string description)[] feeDetails, (uint256 amountSentLD, uint256 amountReceivedLD) receipt)`,
  `function quoteSend(${SEND_PARAM} sendParam, bool payInLzToken) view returns ((uint256 nativeFee, uint256 lzTokenFee) fee)`,
]);
export const endpointAbi = parseAbi(['function eid() view returns (uint32)']);

export type OftReader = Pick<PublicClient, 'getChainId' | 'readContract'>;

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const peerBytes = (a: Address): Hex =>
  pad(a.toLowerCase() as Hex, { size: 32 });

export type OftPeerVerification = {
  sourceChainId: number;
  sourceEid: number;
  oft: Address;
  token: Address;
  endpoint: Address;
  approvalRequired: boolean;
  sharedDecimals: number;
  peerToDestination: Hex;
  expectedPeer: Hex;
};

/**
 * AUSD_OFT route: issuer-designated LayerZero OFT. Read-only — it verifies the
 * source OFT against the registry on chain (token, EID, peer back to the Monad
 * bridge) and dry-quotes with `quoteOFT`/`quoteSend` via eth_call. Monad
 * testnet has no AUSD OFT, so testnet destinations are UNAVAILABLE.
 */
export class AusdOftAdapter implements FundingRouteAdapter {
  readonly route = 'AUSD_OFT' as const;
  constructor(
    readonly options: {
      readers: Readonly<Record<number, OftReader>>;
      quoteTtlSeconds?: number;
      extraOptions?: Hex;
    },
  ) {}

  private sourceAusd(token: TokenRef): Asset | null {
    if (token.address === 'native') return null;
    return (
      ausdAssets().find(
        (a) =>
          a.chainId === token.chainId &&
          same(a.address, token.address) &&
          a.decimals === token.decimals,
      ) ?? null
    );
  }

  private route_(request: FundingRequest):
    | { ok: false; capability: RouteCapability }
    | {
        ok: true;
        destination: AusdOftConfigured;
        peer: AusdOftConfigured['peers'][number];
        reader: OftReader;
      } {
    const mode = modeForChain(request.destination.chainId);
    const fail = (
      availability: RouteCapability['availability'],
      reason: string,
    ) => ({
      ok: false as const,
      capability: { route: this.route, availability, reason, mode },
    });
    const destination = ausdOftNetwork(request.destination.chainId);
    if (!destination)
      return fail('UNAVAILABLE', 'destination chain has no AUSD OFT entry');
    if (destination.status === 'NO_AUSD_OFT')
      return fail(
        'UNAVAILABLE_IN_NETWORK_PROFILE',
        `${destination.reason} (EID ${destination.eid})`,
      );
    if (!this.sourceAusd(request.source.token))
      return fail('UNAVAILABLE', 'source asset is not registered AUSD');
    const peer = destination.peers.find(
      (p) => p.chainId === request.source.token.chainId,
    );
    if (!peer)
      return fail(
        'UNAVAILABLE',
        `chain ${request.source.token.chainId} is not an AUSD OFT peer of EID ${destination.eid}`,
      );
    const reader = this.options.readers[peer.chainId];
    if (!reader)
      return fail('UNAVAILABLE', `no read RPC for chain ${peer.chainId}`);
    return { ok: true, destination, peer, reader };
  }

  async capability(request: FundingRequest): Promise<RouteCapability> {
    const r = this.route_(request);
    if (!r.ok) return r.capability;
    return {
      route: this.route,
      availability: 'AVAILABLE',
      reason: `AUSD OFT peer EID ${r.peer.eid} → EID ${r.destination.eid}`,
      mode: isMutationEnabledChain(request.destination.chainId)
        ? 'SIMULATION'
        : 'MAINNET_READ_ONLY',
    };
  }

  /** Verifies the source OFT matches the registry before any quote is trusted. */
  async verifyPeer(request: FundingRequest): Promise<OftPeerVerification> {
    const r = this.route_(request);
    if (!r.ok) throw new FundingError('ROUTE_UNAVAILABLE', r.capability.reason);
    const { reader, peer, destination } = r;
    const chainId = await reader.getChainId();
    if (chainId !== peer.chainId)
      throw new FundingError(
        'NETWORK_MISMATCH',
        `reader for ${peer.chainId} reports chain ${chainId}`,
      );
    const read = <T>(
      address: Address,
      functionName: string,
      args: unknown[] = [],
    ) =>
      reader.readContract({
        address,
        abi: [...oftAbi, ...endpointAbi],
        functionName,
        args,
      } as Parameters<OftReader['readContract']>[0]) as Promise<T>;
    const [
      token,
      endpoint,
      peerToDestination,
      approvalRequired,
      sharedDecimals,
    ] = await Promise.all([
      read<Address>(peer.peer, 'token'),
      read<Address>(peer.peer, 'endpoint'),
      read<Hex>(peer.peer, 'peers', [destination.eid]),
      read<boolean>(peer.peer, 'approvalRequired'),
      read<number>(peer.peer, 'sharedDecimals'),
    ]);
    const sourceEid = Number(await read<number>(endpoint, 'eid'));
    const expectedPeer = peerBytes(destination.bridge);
    const source = this.sourceAusd(request.source.token)!;
    if (sourceEid !== peer.eid)
      throw new FundingError(
        'NETWORK_MISMATCH',
        `source endpoint EID ${sourceEid} != registry ${peer.eid}`,
      );
    if (!same(peerToDestination, expectedPeer))
      throw new FundingError(
        'NETWORK_MISMATCH',
        `source OFT peer for EID ${destination.eid} is ${peerToDestination}`,
      );
    if (!same(token, source.address))
      throw new FundingError('WRONG_TOKEN', `OFT token ${token}`);
    if (Number(sharedDecimals) !== destination.sharedDecimals)
      throw new FundingError('NETWORK_MISMATCH', 'shared decimals differ');
    return {
      sourceChainId: chainId,
      sourceEid,
      oft: peer.peer,
      token,
      endpoint,
      approvalRequired,
      sharedDecimals: Number(sharedDecimals),
      peerToDestination,
      expectedPeer,
    };
  }

  async quote(request: FundingRequest): Promise<NormalizedQuote> {
    const verification = await this.verifyPeer(request);
    const r = this.route_(request);
    if (!r.ok) throw new FundingError('ROUTE_UNAVAILABLE', r.capability.reason);
    const amount = BigInt(request.source.amount);
    const slippage = BigInt(request.maxSlippageBps);
    const sendParam = {
      dstEid: r.destination.eid,
      to: peerBytes(request.destination.account),
      amountLD: amount,
      minAmountLD: (amount * (10_000n - slippage)) / 10_000n,
      extraOptions: this.options.extraOptions ?? ('0x' as Hex),
      composeMsg: '0x' as Hex,
      oftCmd: '0x' as Hex,
    };
    const [, , receipt] = (await r.reader.readContract({
      address: verification.oft,
      abi: oftAbi,
      functionName: 'quoteOFT',
      args: [sendParam],
    })) as readonly [
      unknown,
      unknown,
      { amountSentLD: bigint; amountReceivedLD: bigint },
    ];
    const fee = (await r.reader.readContract({
      address: verification.oft,
      abi: oftAbi,
      functionName: 'quoteSend',
      args: [{ ...sendParam, minAmountLD: receipt.amountReceivedLD }, false],
    })) as { nativeFee: bigint; lzTokenFee: bigint };
    const now = request.now;
    const body = {
      route: this.route,
      verification,
      sendParam: {
        ...sendParam,
        amountLD: String(amount),
        minAmountLD: String(sendParam.minAmountLD),
      },
      receipt: {
        amountSentLD: String(receipt.amountSentLD),
        amountReceivedLD: String(receipt.amountReceivedLD),
      },
      fee: {
        nativeFee: String(fee.nativeFee),
        lzTokenFee: String(fee.lzTokenFee),
      },
    };
    return {
      quoteId: contentHash({ ...body, now }),
      route: this.route,
      provider: 'layerzero-oft',
      mode: 'MAINNET_READ_ONLY',
      dry: true,
      source: request.source.token,
      destination: request.destination.token,
      recipient: request.destination.account,
      amountIn: String(receipt.amountSentLD),
      amountOut: String(receipt.amountReceivedLD),
      minAmountOut: String(receipt.amountReceivedLD),
      fees: [
        {
          kind: 'MESSAGING',
          token: {
            chainId: verification.sourceChainId,
            address: 'native',
            symbol: 'NATIVE',
            decimals: 18,
          },
          amount: String(fee.nativeFee),
        },
      ],
      quotedAt: now,
      expiresAt: now + (this.options.quoteTtlSeconds ?? 120),
      timeEstimateSeconds: null,
      depositAddress: null,
      correlationId: null,
      artifactHash: contentHash(body),
    };
  }
}

export const AUSD_CANONICAL_SYMBOL = ausdRegistry.canonicalSymbol;
