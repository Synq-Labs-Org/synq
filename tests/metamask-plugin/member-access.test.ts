import { sendAccessTypedData } from '@synq/identity/server';
import { hashTypedData } from 'viem';
import { describe, expect, it } from 'vitest';
import { memberAccessTypedData } from '../../packages/metamask-synq-plugin/src/core/session.js';

describe('MetaMask plugin member sign-in', () => {
  it('signs exactly the EIP-712 payload the Synq API verifies', () => {
    const challenge = {
      challengeId: `0x${'1'.repeat(64)}` as `0x${string}`,
      groupId: `0x${'2'.repeat(64)}` as `0x${string}`,
      memberId: 'member_3',
      principalId: 'mera:abc',
      signer: `0x${'3'.repeat(40)}` as `0x${string}`,
      membershipEpoch: 4,
      chainId: 10143,
      account: `0x${'4'.repeat(40)}` as `0x${string}`,
      scope: 'MEMBER_CONTRIBUTE' as const,
      issuedAt: 1_790_000_000,
      expiresAt: 1_790_000_120,
    };
    expect(hashTypedData(memberAccessTypedData(challenge))).toBe(
      hashTypedData(sendAccessTypedData(challenge)),
    );
  });
});
