import { decodeEventLog, erc20Abi, keccak256, toHex } from 'viem';
import type {
  FetchLike,
  FundingSession,
  GroupView,
} from '../src/core/synq-api.js';
import { NETWORK } from '../src/core/network.js';
import {
  AUSD,
  CHAIN_GROUP_ID,
  FakeChain,
  GROUP_ID,
  MEMBER,
  OTHER,
  SAFE,
} from './fakes.js';

export const TOKEN = 'test-admin-token-0123456789abcdef';

/** Behaves like apps/api's group, funding, treasury, world and mandate-proposal routes. */
export class FakeSynqApi {
  calls: { method: string; path: string; body: unknown }[] = [];
  group: GroupView = {
    groupId: GROUP_ID,
    chainGroupId: CHAIN_GROUP_ID,
    chainId: NETWORK.chainId,
    account: SAFE.toLowerCase() as `0x${string}`,
    owners: [MEMBER, OTHER],
    threshold: 2,
    membershipEpoch: 1,
    memberships: [
      {
        groupId: GROUP_ID,
        memberId: 'alice',
        principalId: 'p-alice',
        role: 'APPROVER',
        signer: MEMBER.toLowerCase(),
        status: 'ACTIVE',
        revokedAt: null,
      },
      {
        groupId: GROUP_ID,
        memberId: 'bob',
        principalId: 'p-bob',
        role: 'APPROVER',
        signer: OTHER.toLowerCase(),
        status: 'ACTIVE',
        revokedAt: null,
      },
    ],
  };
  sessions = new Map<string, FundingSession>();
  quoteTtl = 600;
  tamperQuote?: (s: FundingSession) => FundingSession;
  authorizeState?: FundingSession['state'];

  constructor(
    private readonly chain: FakeChain,
    public now: () => number,
  ) {}

  private json(status: number, body: unknown) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }

  fetch: FetchLike = async (url, init) => {
    const { pathname } = new URL(url);
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    this.calls.push({ method, path: pathname, body });
    const admin =
      (init.headers as Record<string, string>).authorization ===
      `Bearer ${TOKEN}`;
    let m: RegExpMatchArray | null;
    if (method === 'GET' && (m = pathname.match(/^\/v1\/groups\/([^/]+)$/)))
      return decodeURIComponent(m[1]!) === GROUP_ID
        ? this.json(200, this.group)
        : this.json(404, { error: 'NOT_FOUND' });
    if (!admin) return this.json(401, { error: 'UNAUTHORIZED' });
    if (method === 'POST' && pathname === '/v1/funding/quotes') {
      const active = this.group.memberships
        .filter((x) => x.status === 'ACTIVE')
        .map((x) => x.signer.toLowerCase());
      if (
        body.destination.account !== this.group.account ||
        !active.includes(body.source.sender.toLowerCase())
      )
        return this.json(403, { error: 'FUNDING_BINDING_INVALID' });
      const existing = [...this.sessions.values()].find(
        (s) => s.idempotencyKey === `correlation:${body.requestId}`,
      );
      if (existing) return this.json(200, existing);
      const nowS = Math.floor(this.now() / 1000);
      let s: FundingSession = {
        sessionId: keccak256(toHex(`session-${body.requestId}`)),
        groupId: body.groupId,
        route: 'DIRECT_MONAD_AUSD',
        idempotencyKey: `correlation:${body.requestId}`,
        state: 'QUOTED',
        sourceTransactionHash: null,
        creditId: null,
        creditedAmount: null,
        quote: {
          quoteId: `q-${body.requestId}`,
          route: 'DIRECT_MONAD_AUSD',
          source: body.source.token,
          destination: body.destination.token,
          recipient: body.destination.account,
          sourceSender: body.source.sender,
          amountIn: body.source.amount,
          amountOut: body.source.amount,
          expiresAt: nowS + this.quoteTtl,
          correlationId: body.requestId,
        },
      };
      if (this.tamperQuote) s = this.tamperQuote(s);
      this.sessions.set(s.sessionId, s);
      return this.json(200, s);
    }
    if ((m = pathname.match(/^\/v1\/funding\/(0x[0-9a-f]{64})(?:\/(\w+))?$/))) {
      const s = this.sessions.get(m[1]!);
      if (!s) return this.json(404, { error: 'FUNDING_NOT_FOUND' });
      const action = m[2];
      if (!action) return this.json(200, s);
      if (action === 'authorize') {
        s.state =
          this.authorizeState ??
          (s.quote.expiresAt <= Math.floor(this.now() / 1000)
            ? 'EXPIRED'
            : 'USER_AUTHORIZED');
        return this.json(200, s);
      }
      if (action === 'source') {
        const r = (await this.chain.request({
          method: 'eth_getTransactionReceipt',
          params: [body.transactionHash],
        })) as {
          logs: {
            address: string;
            topics: `0x${string}`[];
            data: `0x${string}`;
          }[];
        } | null;
        const ok = r?.logs.some((l) => {
          if (l.address.toLowerCase() !== AUSD.toLowerCase()) return false;
          const e = decodeEventLog({
            abi: erc20Abi,
            data: l.data,
            topics: l.topics as [`0x${string}`, ...`0x${string}`[]],
          });
          return (
            e.eventName === 'Transfer' &&
            e.args.from.toLowerCase() === s.quote.sourceSender &&
            e.args.to.toLowerCase() === s.quote.recipient &&
            String(e.args.value) === s.quote.amountIn
          );
        });
        if (!ok) return this.json(422, { error: 'DESTINATION_MISMATCH' });
        s.state = 'SOURCE_SUBMITTED';
        s.sourceTransactionHash = body.transactionHash;
        return this.json(200, s);
      }
      if (action === 'reconcile') {
        if (s.state === 'SOURCE_SUBMITTED') {
          s.state = 'CREDITED';
          s.creditId = `${NETWORK.chainId}:${s.sourceTransactionHash}:0`;
          s.creditedAmount = s.quote.amountIn;
        }
        return this.json(200, s);
      }
    }
    if (
      method === 'GET' &&
      pathname === `/v1/groups/${CHAIN_GROUP_ID}/treasury`
    ) {
      const bal = this.chain.balance(SAFE).toString();
      const events = [...this.sessions.values()]
        .filter((s) => s.sourceTransactionHash)
        .map((s, i) => ({
          transactionHash: s.sourceTransactionHash!,
          logIndex: 0,
          blockNumber: 100 + i,
          from: s.quote.sourceSender!,
          amount: s.quote.amountIn,
        }));
      return this.json(200, {
        schemaVersion: 1,
        groupId: CHAIN_GROUP_ID,
        account: SAFE.toLowerCase(),
        chainId: NETWORK.chainId,
        indexedThroughBlock: 120,
        coreAsset: { address: AUSD.toLowerCase(), symbol: 'AUSD', decimals: 6 },
        core: {
          balance: bal,
          reserved: '0',
          pendingDebits: '0',
          free: bal,
          overcommitted: false,
        },
        pendingInbound: '0',
        contributions: {
          total: events.reduce((a, e) => a + BigInt(e.amount), 0n).toString(),
          count: events.length,
          byContributor: [],
          events,
        },
      });
    }
    if (method === 'GET' && pathname === `/v1/world/${GROUP_ID}`) {
      const meta = {
        provenance: 'KERNEL',
        source: 'test',
        observedAt: 1,
        freshness: 'FRESH',
        confidence: 1,
      };
      return this.json(200, {
        snapshotId: `0x${'cd'.repeat(32)}`,
        generatedAt: 1,
        riskState: {
          value: {
            status: 'HEALTHY',
            reasons: [],
            attestationRef: 'cre:1',
            referenceDeviationBps: 12,
          },
          meta,
        },
        marketSnapshots: {
          value: [
            {
              pair: 'MON/AUSD',
              price: '3500000',
              priceDecimals: 6,
              source: 'kuru',
              chainId: NETWORK.chainId,
              observedAt: 1,
              maxAgeSeconds: 60,
            },
          ],
          meta,
        },
        mandates: {
          value: [
            {
              mandateId: 'dca-1',
              version: 1,
              status: 'ACTIVE',
              chainMandateId: `0x${'ab'.repeat(32)}`,
              perActionCap: '2000000',
              cumulativeBudget: '20000000',
              spentToken: '4000000',
              reservedToken: '0',
              maxSlippageBps: 50,
              pluginIds: ['kuru'],
              validAfter: 1,
              validUntil: 2,
            },
          ],
          meta,
        },
        workflows: {
          value: [
            {
              workflowId: 'wf-1',
              type: 'DCA',
              status: 'RUNNING',
              intentId: null,
              startedAt: 1,
              nextEventAt: 5,
            },
          ],
          meta,
        },
      });
    }
    if (method === 'POST' && pathname === '/v1/mandate-proposals') {
      return this.json(201, {
        proposalId: keccak256(toHex(JSON.stringify(body.mandate))),
        groupId: body.groupId,
        change: body.change,
        securitySensitive: false,
        mandate: body.mandate,
        mandateHash: `0x${'ee'.repeat(32)}`,
        safeTx: {
          safe: this.group.account,
          chainId: NETWORK.chainId,
          to: NETWORK.mandateRegistry,
          data: '0x',
          nonce: '7',
        },
        safeTxHash: `0x${'ff'.repeat(32)}`,
        state: 'PENDING',
        required: 2,
        counted: 0,
        executionTx: null,
        reason: null,
        proposedBy: { memberId: null, source: 'OPERATOR' },
      });
    }
    return this.json(404, { error: 'NO_ROUTE' });
  };
}
