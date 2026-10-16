/**
 * A guarded EIP-1193 wallet for Circle App Kit scripts on Arc testnet.
 *
 * The kit never receives the key. It talks to this provider, which:
 * - answers reads by forwarding to the verified Arc RPC;
 * - passes every `eth_sendTransaction` through the plan's `KitTxGuard`
 *   (target, selector, spender, beneficiary, amounts, min output) and only
 *   then fills nonce/gas/fees (Arc 20 gwei floor, value+gas must fit the
 *   USDC balance) and signs locally;
 * - refuses typed-data and message signatures and chain switches.
 * Every broadcast hash is recorded for fee accounting.
 */
import {
  encodeFunctionData,
  erc20Abi,
  numberToHex,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import type { PrivateKeyAccount } from 'viem/accounts';
import type { ChainProfile } from '@synq/chain-registry/arc';
import { KitTxGuard, KitTxGuardError } from '@synq/plugin-circle-app-kit';
import { planNativeGas } from '@synq/plugin-circle-gas';

type Req = { method: string; params?: readonly unknown[] };
type RpcTx = { from: Address; to?: Address; data?: Hex; value?: Hex; gas?: Hex };

export function guardedArcWallet(input: {
  profile: ChainProfile;
  client: PublicClient;
  signer: PrivateKeyAccount;
  rpcUrl: string;
  /** Replaced for each operation (swap, deposit, withdrawal). */
  guard: () => KitTxGuard;
  log?: (msg: string) => void;
}) {
  const chainIdHex = numberToHex(input.profile.chainId);
  const sent: Hex[] = [];
  const refused: { to?: Address; data?: Hex; code: string }[] = [];
  const log = input.log ?? (() => {});
  const forward = async (method: string, params: readonly unknown[] = []) => {
    const res = await fetch(input.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const body = (await res.json()) as {
      result?: unknown;
      error?: { code: number; message: string };
    };
    if (body.error)
      throw Object.assign(new Error(body.error.message), body.error);
    return body.result;
  };
  const provider = {
    on() {},
    removeListener() {},
    async request({ method, params = [] }: Req): Promise<unknown> {
      switch (method) {
        case 'eth_requestAccounts':
        case 'eth_accounts':
          return [input.signer.address];
        case 'eth_chainId':
          return chainIdHex;
        case 'wallet_switchEthereumChain': {
          const want = (params[0] as { chainId?: string } | undefined)?.chainId;
          if (want?.toLowerCase() !== chainIdHex)
            throw Object.assign(new Error(`only ${chainIdHex}`), { code: 4902 });
          return null;
        }
        case 'eth_signTypedData_v4':
        case 'eth_signTypedData':
        case 'personal_sign':
        case 'eth_sign':
        case 'eth_signTransaction':
        case 'wallet_sendCalls':
          try {
            input.guard().refuseSignature(method);
          } catch (error) {
            throw Object.assign(error as Error, { code: 4001 });
          }
          throw new Error('unreachable');
        case 'wallet_getCapabilities':
          throw Object.assign(new Error('not supported'), { code: 4200 });
        case 'eth_sendTransaction': {
          const tx = params[0] as RpcTx;
          const value = tx.value ? BigInt(tx.value) : 0n;
          let record;
          try {
            record = input.guard().check({
              from: tx.from,
              to: tx.to,
              data: tx.data,
              value,
            });
          } catch (error) {
            const e = error as KitTxGuardError;
            log(`REFUSED ${e.code}: ${e.message}`);
            refused.push({ to: tx.to, data: tx.data, code: e.code });
            throw Object.assign(e, { code: 4001 });
          }
          const [nonce, fees, nativeBalance] = await Promise.all([
            input.client.getTransactionCount({
              address: input.signer.address,
              blockTag: 'pending',
            }),
            input.client.estimateFeesPerGas(),
            input.client.getBalance({ address: input.signer.address }),
          ]);
          const gas =
            ((await input.client.estimateGas({
              account: input.signer.address,
              to: tx.to,
              data: tx.data,
              value,
            })) *
              130n) /
            100n;
          const plan = planNativeGas({
            profile: input.profile,
            gas,
            fees,
            nativeBalance,
            valueWei: value,
          });
          if (!plan.ok) throw new Error(`${plan.code}: ${plan.message}`);
          const raw = await input.signer.signTransaction({
            type: 'eip1559',
            chainId: input.profile.chainId,
            to: tx.to,
            data: tx.data,
            value,
            nonce,
            gas: plan.gas,
            maxFeePerGas: plan.maxFeePerGas,
            maxPriorityFeePerGas: plan.maxPriorityFeePerGas,
          });
          const hash = (await forward('eth_sendRawTransaction', [raw])) as Hex;
          sent.push(hash);
          log(`${record.step} ${record.to} ${record.selector} -> ${hash}`);
          return hash;
        }
        default:
          return forward(method, params);
      }
    },
  };
  return { provider, sent, refused };
}

/** Sets a leftover ERC-20 allowance back to zero (owner-signed, Arc gas rules). */
export async function revokeAllowance(
  chain: { profile: ChainProfile; client: PublicClient },
  signer: PrivateKeyAccount,
  tokenAddress: Address,
  spender: Address,
) {
  const data = encodeFunctionData({
    abi: erc20Abi,
    functionName: 'approve',
    args: [spender, 0n],
  });
  const [nonce, fees, nativeBalance, estimate] = await Promise.all([
    chain.client.getTransactionCount({ address: signer.address, blockTag: 'pending' }),
    chain.client.estimateFeesPerGas(),
    chain.client.getBalance({ address: signer.address }),
    chain.client.estimateGas({ account: signer.address, to: tokenAddress, data }),
  ]);
  const plan = planNativeGas({
    profile: chain.profile,
    gas: (estimate * 130n) / 100n,
    fees,
    nativeBalance,
    valueWei: 0n,
  });
  if (!plan.ok) throw new Error(`${plan.code}: ${plan.message}`);
  const hash = await chain.client.sendRawTransaction({
    serializedTransaction: await signer.signTransaction({
      type: 'eip1559',
      chainId: chain.profile.chainId,
      to: tokenAddress,
      data,
      nonce,
      gas: plan.gas,
      maxFeePerGas: plan.maxFeePerGas,
      maxPriorityFeePerGas: plan.maxPriorityFeePerGas,
    }),
  });
  const r = await chain.client.waitForTransactionReceipt({ hash });
  return { hash, status: r.status, explorer: `${chain.profile.explorer}/tx/${hash}` };
}
