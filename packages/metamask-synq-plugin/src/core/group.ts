import { getAddress, isAddress, type Address, type PublicClient } from 'viem';
import { assertChain, verifiedGroupSafe } from './chain.js';
import { fail } from './errors.js';
import type { SynqHost } from './host.js';
import { NETWORK, sameAddress } from './network.js';
import type { GroupView, MembershipView, SynqApi } from './synq-api.js';

export type Deps = {
  host: SynqHost;
  api: SynqApi;
  now: () => number;
};

export type VerifiedGroup = {
  group: GroupView;
  safe: Address;
  client: PublicClient;
};

/** Synq's view of the group, confirmed against MandateRegistry on Monad testnet. */
export async function verifiedGroup(
  deps: Deps,
  groupId: string,
): Promise<VerifiedGroup> {
  const client = deps.host.publicClient(NETWORK.chainId);
  await assertChain(client);
  const group = await deps.api.group(groupId);
  if (group.chainId !== NETWORK.chainId)
    fail(
      'WRONG_CHAIN',
      `Group ${groupId} lives on chain ${group.chainId}, not ${NETWORK.caip2}`,
    );
  const safe = await verifiedGroupSafe(
    client,
    group.chainGroupId,
    group.account,
  );
  return { group, safe, client };
}

/** The member wallet: explicit --from must be one of the host's wallets and the selected one. */
export function resolveSpender(host: SynqHost, from?: string): Address {
  const { selected, all } = host.walletAddresses();
  if (!selected && all.length > 1)
    fail(
      'WRONG_SPENDER',
      'Several wallets are available and the selected one is unknown; run `mm wallet select`',
    );
  if (from !== undefined && from !== '') {
    if (!isAddress(from))
      fail('INVALID_INPUT', `--from ${from} is not an address`);
    if (!all.some((a) => sameAddress(a, from)))
      fail(
        'WRONG_SPENDER',
        `${from} is not a wallet of this Agent Wallet account`,
      );
    if (selected && !sameAddress(selected, from))
      fail(
        'WRONG_SPENDER',
        `--from ${from} is not the selected wallet ${selected}; run \`mm wallet select\` first`,
      );
    return getAddress(from);
  }
  if (selected) return selected;
  if (all.length === 1) return all[0]!;
  return fail(
    'WRONG_SPENDER',
    'The Agent Wallet has no EVM wallet; run `mm init`',
  );
}

export function membershipOf(
  group: GroupView,
  signer: Address,
): MembershipView {
  const mine = group.memberships.filter((m) => sameAddress(m.signer, signer));
  const active = mine.find((m) => m.status === 'ACTIVE');
  if (active) return active;
  if (mine.length)
    fail(
      'MEMBERSHIP_REVOKED',
      `${signer}'s membership in ${group.groupId} was revoked`,
    );
  return fail(
    'NOT_A_MEMBER',
    `${signer} is not a member signer of group ${group.groupId}`,
  );
}

export const membershipStatus = (group: GroupView, signer: Address | null) => {
  if (!signer) return 'UNKNOWN' as const;
  const mine = group.memberships.filter((m) => sameAddress(m.signer, signer));
  if (mine.some((m) => m.status === 'ACTIVE')) return 'ACTIVE' as const;
  return mine.length ? ('REVOKED' as const) : ('NONE' as const);
};
