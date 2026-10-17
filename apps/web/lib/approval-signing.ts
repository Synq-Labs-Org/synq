import { z } from 'zod';
import type { SigningRequestSchema } from '@synq/contracts';
import { injectedProvider, NO_WALLET_MESSAGE } from './wallet-login';

export const ARC_TESTNET_CHAIN_ID = 5042002;
const ARC_CHAIN_HEX = `0x${ARC_TESTNET_CHAIN_ID.toString(16)}`;

type SigningRequest = z.output<typeof SigningRequestSchema>;

const Signature = z.string().regex(/^0x[0-9a-fA-F]{130}$/);

/**
 * Asks the user's own wallet to sign each step's typed data, in order.
 * Refuses when the connected account is not the required signer. The typed
 * data is passed to the wallet exactly as the server sent it.
 */
export async function signSteps(request: SigningRequest): Promise<string[]> {
  const provider = injectedProvider();
  if (!provider) throw new Error(NO_WALLET_MESSAGE);
  const accounts = z
    .array(z.string())
    .min(1)
    .parse(await provider.request({ method: 'eth_requestAccounts' }));
  const connected = accounts[0]!;
  if (connected.toLowerCase() !== request.signerAddress.toLowerCase())
    throw new Error(
      `Your wallet is on ${connected.slice(0, 6)}…${connected.slice(-4)}, but this request must be signed by ${request.signer}. Switch account in your wallet and try again.`,
    );
  const chain = await provider.request({ method: 'eth_chainId' });
  if (typeof chain !== 'string' || chain.toLowerCase() !== ARC_CHAIN_HEX) {
    try {
      await provider.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: ARC_CHAIN_HEX }],
      });
    } catch {
      throw new Error(
        'Switch your wallet to Arc testnet (chain 5042002) and try again. If it is not listed, add it in your wallet first.',
      );
    }
  }
  const signatures: string[] = [];
  for (const step of request.steps) {
    const signature = Signature.parse(
      await provider.request({
        method: 'eth_signTypedData_v4',
        params: [request.signerAddress, JSON.stringify(step.typedData)],
      }),
    );
    signatures.push(signature);
  }
  return signatures;
}
