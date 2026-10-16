import type { ChannelLinkChallenge } from './channel-link.js';

export const CHANNEL_LINK_DOMAIN = {
  name: 'Synq Channel Link',
  version: '1',
} as const;
export const CHANNEL_LINK_TYPES = {
  ChannelLink: [
    { name: 'purpose', type: 'string' },
    { name: 'statement', type: 'string' },
    { name: 'challengeId', type: 'string' },
    { name: 'workspaceId', type: 'string' },
    { name: 'channel', type: 'string' },
    { name: 'channelUserId', type: 'string' },
    { name: 'wallet', type: 'address' },
    { name: 'nonce', type: 'bytes32' },
    { name: 'issuedAt', type: 'uint64' },
    { name: 'expiresAt', type: 'uint64' },
  ],
} as const;

export function channelLinkTypedData(c: ChannelLinkChallenge) {
  return {
    domain: CHANNEL_LINK_DOMAIN,
    types: CHANNEL_LINK_TYPES,
    primaryType: 'ChannelLink' as const,
    message: {
      purpose: c.purpose,
      statement: c.statement,
      challengeId: c.challengeId,
      workspaceId: c.workspaceId,
      channel: c.channel,
      channelUserId: c.channelUserId,
      wallet: c.wallet,
      nonce: c.nonce,
      issuedAt: BigInt(c.issuedAt),
      expiresAt: BigInt(c.expiresAt),
    },
  };
}
