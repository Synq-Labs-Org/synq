import { SynqPluginError, fail } from './errors.js';

export type MembershipView = {
  groupId: string;
  memberId: string;
  principalId: string;
  role: 'APPROVER' | 'OPERATOR';
  signer: string;
  status: 'ACTIVE' | 'REVOKED';
  revokedAt: string | null;
};

export type GroupView = {
  groupId: string;
  chainGroupId: `0x${string}`;
  chainId: number;
  account: `0x${string}`;
  owners: string[];
  threshold: number;
  membershipEpoch: number;
  memberships: MembershipView[];
};

export type TokenRef = {
  chainId: number;
  address: string;
  symbol: string;
  decimals: number;
};

export type FundingRequest = {
  requestId: string;
  groupId: string;
  destination: { chainId: number; account: string; token: TokenRef };
  source: { token: TokenRef; amount: string; sender: string; refundTo: string };
  maxSlippageBps: number;
  now: number;
};

export type FundingState =
  | 'QUOTED'
  | 'USER_AUTHORIZED'
  | 'SOURCE_SUBMITTED'
  | 'BRIDGE_PENDING'
  | 'INTENT_PENDING'
  | 'DESTINATION_RECEIVED'
  | 'INDEXED'
  | 'CREDITED'
  | 'EXPIRED'
  | 'INCOMPLETE_DEPOSIT'
  | 'REFUNDED'
  | 'FAILED'
  | 'RECONCILIATION_REQUIRED';

export type FundingSession = {
  sessionId: `0x${string}`;
  groupId: string;
  route: string;
  idempotencyKey: string;
  state: FundingState;
  sourceTransactionHash: string | null;
  creditId: string | null;
  creditedAmount: string | null;
  quote: {
    quoteId: string;
    route: string;
    source: TokenRef;
    destination: TokenRef;
    recipient: string;
    sourceSender?: string;
    amountIn: string;
    amountOut: string;
    expiresAt: number;
    correlationId: string | null;
  };
};

export type ContributionEvent = {
  transactionHash: string;
  logIndex: number;
  blockNumber: number;
  from: string;
  amount: string;
};

export type TreasuryView = {
  groupId: string;
  account: string;
  chainId: number;
  indexedThroughBlock: number | string;
  coreAsset: { address: string; symbol: string; decimals: number };
  core: {
    balance: string;
    reserved: string;
    pendingDebits: string;
    free: string;
    overcommitted: boolean;
  };
  pendingInbound: string;
  contributions: {
    total: string;
    count: number;
    events: ContributionEvent[];
  };
};

type Observed<T> = { value: T; meta: { freshness: string; source: string } };
export type WorldView = {
  snapshotId: string;
  generatedAt: number;
  riskState: Observed<{
    status: string;
    reasons: string[];
    attestationRef: string | null;
    referenceDeviationBps: number | null;
  }>;
  marketSnapshots: Observed<
    {
      pair: string;
      price: string;
      priceDecimals: number;
      source: string;
      observedAt: number;
    }[]
  >;
  mandates: Observed<
    {
      mandateId: string;
      version: number;
      status: string;
      chainMandateId: string;
      perActionCap: string;
      cumulativeBudget: string;
      spentToken: string;
      reservedToken: string;
      maxSlippageBps: number;
      pluginIds: string[];
      validAfter: number;
      validUntil: number;
    }[]
  >;
  workflows: Observed<
    {
      workflowId: string;
      type: string;
      status: string;
      intentId: string | null;
      nextEventAt: number | null;
    }[]
  >;
};

export type MandateProposalView = {
  proposalId: string;
  groupId: string;
  change: 'NEW' | 'SUPERSEDE';
  securitySensitive: boolean;
  mandateHash: string;
  safeTx: { safe: string; chainId: number; to: string; nonce: string | number };
  safeTxHash: string;
  state: 'PENDING' | 'READY' | 'EXECUTED' | 'REJECTED' | 'STALE';
  required: number;
  counted: number;
  executionTx: string | null;
};

export type SynqApiConfig = { baseUrl: string; token: string | null };
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

export function apiConfigFromEnv(
  env: Record<string, string | undefined>,
): SynqApiConfig {
  const baseUrl = (env.SYNQ_API_URL ?? 'http://127.0.0.1:3200').replace(
    /\/+$/,
    '',
  );
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return fail('CONFIG_INVALID', 'SYNQ_API_URL is not a URL');
  }
  if (url.protocol !== 'https:' && !LOOPBACK.has(url.hostname))
    fail(
      'CONFIG_INVALID',
      'SYNQ_API_URL must be https unless it is a loopback address',
    );
  if (env.SYNQ_API_TOKEN)
    fail(
      'CONFIG_INVALID',
      'SYNQ_API_TOKEN is no longer used: the plugin authenticates as your member wallet',
      'Unset SYNQ_API_TOKEN and run `mm synq login <group>`.',
    );
  return { baseUrl, token: null };
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const hex = (v: unknown, len: number) =>
  typeof v === 'string' && new RegExp(`^0x[0-9a-fA-F]{${len}}$`).test(v);

function assertGroup(v: unknown): asserts v is GroupView {
  if (
    !isObject(v) ||
    typeof v.groupId !== 'string' ||
    !hex(v.chainGroupId, 64) ||
    typeof v.chainId !== 'number' ||
    !hex(v.account, 40) ||
    !Array.isArray(v.memberships) ||
    !v.memberships.every(
      (m) =>
        isObject(m) &&
        typeof m.memberId === 'string' &&
        hex(m.signer, 40) &&
        (m.status === 'ACTIVE' || m.status === 'REVOKED'),
    )
  )
    fail('SYNQ_API_ERROR', 'Synq API returned a malformed group view');
}

function assertSession(v: unknown): asserts v is FundingSession {
  const q = isObject(v) && isObject(v.quote) ? v.quote : null;
  if (
    !isObject(v) ||
    !hex(v.sessionId, 64) ||
    typeof v.state !== 'string' ||
    !q ||
    !isObject(q.source) ||
    typeof q.recipient !== 'string' ||
    typeof q.amountIn !== 'string' ||
    typeof q.expiresAt !== 'number'
  )
    fail('SYNQ_API_ERROR', 'Synq API returned a malformed funding session');
}

export type MemberAccessChallenge = {
  challengeId: `0x${string}`;
  groupId: string;
  memberId: string;
  principalId: string;
  signer: string;
  membershipEpoch: number;
  chainId: number;
  account: string;
  scope: string;
  issuedAt: number;
  expiresAt: number;
};
export type MemberAccessSession = {
  token: string;
  expiresAt: number;
  memberId: string;
  principalId: string;
  groupId: string;
  scope: string;
};

export class SynqApi {
  constructor(
    private readonly config: SynqApiConfig,
    private readonly fetchImpl: FetchLike = (u, i) => fetch(u, i),
  ) {}

  /** Same API, authenticated with a member session token. */
  as(token: string): SynqApi {
    return new SynqApi({ ...this.config, token }, this.fetchImpl);
  }

  async memberChallenge(body: {
    groupId: string;
    principalId: string;
    scope: 'MEMBER_CONTRIBUTE';
  }): Promise<MemberAccessChallenge> {
    const v = await this.call(
      'POST',
      '/v1/send/access/challenges',
      body,
      false,
    );
    if (!isObject(v) || !hex(v.challengeId, 64) || !hex(v.signer, 40))
      fail('SYNQ_API_ERROR', 'Synq API returned a malformed member challenge');
    return v as MemberAccessChallenge;
  }

  async memberSession(body: {
    challengeId: string;
    signature: string;
  }): Promise<MemberAccessSession> {
    const v = await this.call('POST', '/v1/send/access', body, false);
    if (
      !isObject(v) ||
      typeof v.token !== 'string' ||
      typeof v.expiresAt !== 'number'
    )
      fail('SYNQ_API_ERROR', 'Synq API returned a malformed member session');
    return v as MemberAccessSession;
  }

  private async call(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    auth = true,
  ): Promise<unknown> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (auth) {
      if (!this.config.token)
        fail('SESSION_REQUIRED', `${path} requires a member session`);
      headers.authorization = `Bearer ${this.config.token}`;
    }
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.config.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      throw new SynqPluginError(
        'SYNQ_API_ERROR',
        `Synq API unreachable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (res.status === 401)
      fail('SYNQ_API_UNAUTHORIZED', `Synq API rejected the token on ${path}`);
    if (!res.ok) {
      const code =
        isObject(json) && typeof json.error === 'string' ? json.error : null;
      if (code === 'FUNDING_BINDING_INVALID')
        fail(
          'NOT_A_MEMBER',
          'Synq refused the funding binding: the sender is not an active member signer or the Safe is not the group mandate account',
        );
      fail(
        'SYNQ_API_ERROR',
        `Synq API ${method} ${path} failed with ${res.status}${code ? ` (${code})` : ''}`,
      );
    }
    return json;
  }

  async group(groupId: string): Promise<GroupView> {
    const v = await this.call(
      'GET',
      `/v1/groups/${encodeURIComponent(groupId)}`,
      undefined,
      false,
    );
    assertGroup(v);
    return v;
  }

  async treasury(chainGroupId: string): Promise<TreasuryView> {
    const v = await this.call('GET', `/v1/groups/${chainGroupId}/treasury`);
    if (!isObject(v) || !isObject(v.core) || !isObject(v.contributions))
      fail('SYNQ_API_ERROR', 'Synq API returned a malformed treasury view');
    return v as TreasuryView;
  }

  async world(groupId: string): Promise<WorldView> {
    const v = await this.call(
      'GET',
      `/v1/world/${encodeURIComponent(groupId)}`,
    );
    if (!isObject(v) || !isObject(v.riskState) || !isObject(v.mandates))
      fail('SYNQ_API_ERROR', 'Synq API returned a malformed world snapshot');
    return v as WorldView;
  }

  async quote(request: FundingRequest): Promise<FundingSession> {
    const v = await this.call('POST', '/v1/funding/quotes', request);
    assertSession(v);
    return v;
  }

  async session(sessionId: string): Promise<FundingSession> {
    const v = await this.call('GET', `/v1/funding/${sessionId}`);
    assertSession(v);
    return v;
  }

  async authorize(sessionId: string): Promise<FundingSession> {
    const v = await this.call('POST', `/v1/funding/${sessionId}/authorize`);
    assertSession(v);
    return v;
  }

  async recordSource(
    sessionId: string,
    transactionHash: string,
  ): Promise<FundingSession> {
    const v = await this.call('POST', `/v1/funding/${sessionId}/source`, {
      transactionHash: transactionHash.toLowerCase(),
    });
    assertSession(v);
    return v;
  }

  async reconcile(sessionId: string): Promise<FundingSession> {
    const v = await this.call('POST', `/v1/funding/${sessionId}/reconcile`);
    assertSession(v);
    return v;
  }

  async propose(body: {
    groupId: string;
    mandate: unknown;
    change: 'NEW' | 'SUPERSEDE';
  }): Promise<MandateProposalView> {
    const v = await this.call('POST', '/v1/mandate-proposals', body);
    if (!isObject(v) || typeof v.proposalId !== 'string')
      fail('SYNQ_API_ERROR', 'Synq API returned a malformed proposal view');
    return v as MandateProposalView;
  }
}
