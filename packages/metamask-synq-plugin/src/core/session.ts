import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  getAddress,
  recoverTypedDataAddress,
  type Address,
  type Hex,
} from 'viem';
import { fail } from './errors.js';
import type { SynqHost } from './host.js';
import { NETWORK, sameAddress } from './network.js';
import type { GroupView, MemberAccessChallenge, SynqApi } from './synq-api.js';

export type StoredSession = {
  token: string;
  expiresAt: number;
  groupId: string;
  memberId: string;
  signer: string;
};

export interface SessionStore {
  get(key: string): Promise<StoredSession | null>;
  put(key: string, session: StoredSession): Promise<void>;
}

export class MemorySessionStore implements SessionStore {
  readonly sessions = new Map<string, StoredSession>();
  async get(key: string) {
    return this.sessions.get(key) ?? null;
  }
  async put(key: string, session: StoredSession) {
    this.sessions.set(key, session);
  }
}

export class FileSessionStore implements SessionStore {
  constructor(private readonly dir: string) {}
  static fromEnv(env: Record<string, string | undefined>) {
    return new FileSessionStore(
      env.SYNQ_MM_SESSION_DIR ?? join(homedir(), '.synq-mm', 'sessions'),
    );
  }
  private path(key: string) {
    return join(
      this.dir,
      `${createHash('sha256').update(key).digest('hex')}.json`,
    );
  }
  async get(key: string) {
    try {
      return JSON.parse(
        await readFile(this.path(key), 'utf8'),
      ) as StoredSession;
    } catch {
      return null;
    }
  }
  async put(key: string, session: StoredSession) {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await writeFile(this.path(key), JSON.stringify(session), { mode: 0o600 });
  }
}

/** Mirrors @synq/identity sendAccessTypedData (domain "Synq Send Access" v1). */
export function memberAccessTypedData(c: MemberAccessChallenge) {
  return {
    domain: {
      name: 'Synq Send Access',
      version: '1',
      chainId: c.chainId,
      verifyingContract: getAddress(c.account),
    },
    types: {
      SendAccess: [
        { name: 'challengeId', type: 'bytes32' },
        { name: 'groupId', type: 'bytes32' },
        { name: 'memberId', type: 'string' },
        { name: 'principalId', type: 'string' },
        { name: 'signer', type: 'address' },
        { name: 'membershipEpoch', type: 'uint64' },
        { name: 'scope', type: 'string' },
        { name: 'issuedAt', type: 'uint64' },
        { name: 'expiresAt', type: 'uint64' },
      ],
    },
    primaryType: 'SendAccess' as const,
    message: {
      challengeId: c.challengeId,
      groupId: c.groupId,
      memberId: c.memberId,
      principalId: c.principalId,
      signer: getAddress(c.signer),
      membershipEpoch: c.membershipEpoch,
      scope: c.scope,
      issuedAt: c.issuedAt,
      expiresAt: c.expiresAt,
    },
  };
}

const MIN_REMAINING_SECONDS = 30;

/**
 * Member-scoped Synq credentials: a short-lived token minted by the API after the
 * member's Agent Wallet signs an EIP-712 challenge. No operator token is ever used.
 */
export class MemberSessions {
  constructor(
    private readonly api: SynqApi,
    private readonly store: SessionStore,
    private readonly host: SynqHost,
    private readonly now: () => number,
    private readonly canSign: boolean,
  ) {}

  private key = (chainGroupId: string, signer: string) =>
    `${chainGroupId.toLowerCase()}:${signer.toLowerCase()}`;

  async apiFor(
    group: GroupView,
    safe: Address,
    signer: Address,
  ): Promise<SynqApi> {
    return this.api.as((await this.session(group, safe, signer)).token);
  }

  async session(
    group: GroupView,
    safe: Address,
    signer: Address,
    opts: { refresh?: boolean } = {},
  ): Promise<StoredSession> {
    if (group.groupId.toLowerCase() !== group.chainGroupId.toLowerCase())
      fail(
        'CONFIG_INVALID',
        `group ${group.groupId} is not keyed by its chain group id; member sessions are bound to ${group.chainGroupId}`,
      );
    const nowS = Math.floor(this.now() / 1000);
    const key = this.key(group.chainGroupId, signer);
    const cached = opts.refresh ? null : await this.store.get(key);
    if (cached && cached.expiresAt - MIN_REMAINING_SECONDS > nowS)
      return cached;
    if (!this.canSign)
      fail(
        'SESSION_REQUIRED',
        `no valid member session for ${group.groupId}`,
        `Run \`mm synq login ${group.groupId}\` (sessions last 5 minutes).`,
      );
    const member = group.memberships.find(
      (m) => sameAddress(m.signer, signer) && m.status === 'ACTIVE',
    );
    if (!member)
      fail(
        'NOT_A_MEMBER',
        `${signer} is not an active member of ${group.groupId}`,
      );
    const c = await this.api.memberChallenge({
      groupId: group.chainGroupId.toLowerCase(),
      principalId: member.principalId,
      scope: 'MEMBER_CONTRIBUTE',
    });
    if (
      c.groupId.toLowerCase() !== group.chainGroupId.toLowerCase() ||
      !sameAddress(c.signer, signer) ||
      c.memberId !== member.memberId ||
      c.scope !== 'MEMBER_CONTRIBUTE' ||
      c.chainId !== NETWORK.chainId ||
      !sameAddress(c.account, safe) ||
      c.expiresAt <= nowS
    )
      fail(
        'INTENT_MISMATCH',
        'Synq issued a member challenge for another group, wallet or chain',
      );
    const typedData = memberAccessTypedData(c);
    const signature = await this.host.signTypedData({
      chainId: c.chainId,
      typedData,
      summary: `Sign in to Synq group ${group.groupId} as member ${c.memberId} (funding and proposals, 5 minutes)`,
    });
    const recovered = await recoverTypedDataAddress({
      ...typedData,
      signature,
    });
    if (!sameAddress(recovered, signer))
      fail(
        'WRONG_SPENDER',
        `Agent Wallet signed as ${recovered}, expected ${signer}`,
      );
    const s = await this.api.memberSession({
      challengeId: c.challengeId,
      signature,
    });
    if (
      s.groupId.toLowerCase() !== group.chainGroupId.toLowerCase() ||
      s.scope !== 'MEMBER_CONTRIBUTE' ||
      s.memberId !== member.memberId
    )
      fail(
        'INTENT_MISMATCH',
        'Synq issued a session for another group or scope',
      );
    const stored: StoredSession = {
      token: s.token,
      expiresAt: s.expiresAt,
      groupId: s.groupId,
      memberId: s.memberId,
      signer: signer.toLowerCase(),
    };
    await this.store.put(key, stored);
    return stored;
  }
}

export type { Hex };
