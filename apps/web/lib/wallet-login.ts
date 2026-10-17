import { getAddress } from 'viem';
import { z } from 'zod';
import { ARC_WORKSPACE_CHAIN, WalletSchema } from '@synq/workspaces/contracts';
import { api } from './api';

export type Eip1193Provider = {
  request(input: { method: string; params?: unknown[] }): Promise<unknown>;
};

export function injectedProvider(): Eip1193Provider | null {
  const p = (window as unknown as { ethereum?: Eip1193Provider }).ethereum;
  return p ?? null;
}

export const NO_WALLET_MESSAGE =
  'Open this page in a browser with an injected Ethereum wallet. WalletConnect is not connected yet.';

const ChallengeSchema = z.strictObject({
  challengeId: z.string().uuid(),
  typedData: z.strictObject({
    domain: z.strictObject({
      name: z.literal('Synq Workspace Login'),
      version: z.literal('1'),
      chainId: z.literal(ARC_WORKSPACE_CHAIN),
    }),
    primaryType: z.literal('WorkspaceLogin'),
    types: z.record(
      z.string(),
      z.array(z.strictObject({ name: z.string(), type: z.string() })),
    ),
    message: z.strictObject({
      challengeId: z.string().uuid(),
      wallet: WalletSchema,
      origin: z.string().url(),
      audience: z.literal('web'),
      nonce: z.string().regex(/^[0-9a-f]{64}$/),
      expiresAt: z.string().regex(/^\d+$/),
      statement: z.literal(
        'Sign in to Synq on Arc testnet. This signature does not approve payments or vault setup.',
      ),
    }),
  }),
});
const SessionSchema = z.strictObject({
  principalId: z.string(),
  expiresAt: z.number(),
});

/**
 * Wallet login shared by /workspaces and the hub: an EIP-712 challenge from
 * /v2/auth/challenge signed by the injected wallet, exchanged at
 * /v2/auth/session. The signature proves wallet ownership only; it never
 * approves money.
 */
export async function signInWithWallet(): Promise<{ principalId: string }> {
  const provider = injectedProvider();
  if (!provider) throw new Error(NO_WALLET_MESSAGE);
  const wallets = z
    .array(WalletSchema)
    .min(1)
    .parse(await provider.request({ method: 'eth_requestAccounts' }));
  const wallet = wallets[0]!;
  const c = await api.post('/v2/auth/challenge', ChallengeSchema, {
    wallet,
    audience: 'web',
  });
  const m = c.typedData.message;
  const now = Math.floor(Date.now() / 1000);
  if (
    m.origin !== window.location.origin ||
    m.wallet !== getAddress(wallet) ||
    m.challengeId !== c.challengeId ||
    Number(m.expiresAt) <= now ||
    Number(m.expiresAt) > now + 300
  )
    throw new Error('Invalid sign-in challenge');
  const signature = z
    .string()
    .regex(/^0x[0-9a-fA-F]{130}$/)
    .parse(
      await provider.request({
        method: 'eth_signTypedData_v4',
        params: [wallet, JSON.stringify(c.typedData)],
      }),
    );
  const session = await api.post('/v2/auth/session', SessionSchema, {
    challengeId: c.challengeId,
    signature,
  });
  return { principalId: session.principalId };
}
