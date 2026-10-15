/**
 * The human parties' wallets for the live demo, run as their own OS process
 * so the Supervisor / model process never loads a key:
 *   - the freelancer's wallet (testnet.key): signs EIP-712 messages it is
 *     shown (channel link, invoice issuance, mandate, payment approval),
 *     tops up the agent float, the vault and the client, and relays the
 *     CCTP mint on Arc (it pays that gas);
 *   - the client's wallet (arc-client.key): burns on Sepolia.
 * Sarah's address is derived here from arc-contractor.key (address only), and
 * the "Wallet B" address is generated here and its key discarded.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createWalletClient,
  erc20Abi,
  http,
  parseEther,
  parseEventLogs,
  type Address,
  type Hex,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { sepolia as sepoliaChain } from 'viem/chains';
import { money } from '@synq/domain';
import { token } from '@synq/chain-registry/arc';
import {
  balanceOf,
  connectChain,
  executeTransfer,
} from '@synq/execution-worker/arc';
import { burnOnSource, mintOnDestination } from '@synq/execution-worker/cctp';
import type { CctpTransfer } from '@synq/plugin-circle-cctp';

export type WalletRequest = { id: number; op: string; args: unknown[] };
export type WalletMessage =
  | {
      type: 'ready';
      owner: Address;
      client: Address;
      sarah: Address;
      walletB: Address;
    }
  | { type: 'event'; id: number; name: string; value: unknown }
  | { type: 'result'; id: number; ok: true; value: unknown }
  | { type: 'result'; id: number; ok: false; error: string };

export type ArcFunding = Readonly<{
  what: string;
  chain: string;
  hash: Hex;
  explorer: string;
  /** Arc transfers between workspace wallets, booked in the ledger. */
  arc: {
    from: Address;
    to: Address;
    amount: bigint;
    logIndex: number;
    feeWei: bigint;
  } | null;
}>;

const keyOf = (f: string) => {
  const k = readFileSync(join(process.env.HOME!, '.synq', f), 'utf8').trim();
  return (k.startsWith('0x') ? k : `0x${k}`) as Hex;
};
const owner = privateKeyToAccount(keyOf('testnet.key'));
const client = privateKeyToAccount(keyOf('arc-client.key'));
const sarah = privateKeyToAccount(keyOf('arc-contractor.key')).address;
const walletB = privateKeyToAccount(generatePrivateKey()).address;
const arcP = connectChain('arc-testnet');
const sepoliaP = connectChain('eth-sepolia');
const arcUsdc = token('arc-testnet', 'USDC');
const sepUsdc = token('eth-sepolia', 'USDC');
const send = (m: WalletMessage) => process.send!(m);

async function arcTransfer(what: string, to: Address, amount: bigint) {
  const arc = await arcP;
  const f = await executeTransfer(arc, owner, {
    from: owner.address,
    to,
    amount: money(arcUsdc, amount),
  });
  const r = await arc.client.getTransactionReceipt({ hash: f.hash });
  const log = parseEventLogs({
    abi: erc20Abi,
    eventName: 'Transfer',
    logs: r.logs,
  }).find((l) => l.address.toLowerCase() === arcUsdc.address.toLowerCase())!;
  return {
    what,
    chain: 'arc-testnet',
    hash: f.hash,
    explorer: f.explorer,
    arc: {
      from: owner.address,
      to,
      amount,
      logIndex: log.logIndex!,
      feeWei: f.feeWei,
    },
  } satisfies ArcFunding;
}

const ops: Record<string, (id: number, ...args: never[]) => Promise<unknown>> =
  {
    signTypedData: async (_id, typedData: never) =>
      owner.signTypedData(typedData),
    fund: async (
      _id,
      input: {
        agent: Address;
        agentMin: bigint;
        agentTopUp: bigint;
        vault: Address;
        vaultMin: bigint;
        vaultTopUp: bigint;
        client: Address;
        clientSepoliaUsdcMin: bigint;
      },
    ) => {
      const arc = await arcP;
      const sepolia = await sepoliaP;
      const out: ArcFunding[] = [];
      if (
        (await balanceOf(arc, arcUsdc, input.agent)).baseUnits < input.agentMin
      )
        out.push(
          await arcTransfer(
            'agent gas float (Arc USDC)',
            input.agent,
            input.agentTopUp,
          ),
        );
      if (
        (await balanceOf(arc, arcUsdc, input.vault)).baseUnits < input.vaultMin
      )
        out.push(
          await arcTransfer(
            'vault payout float (Arc USDC)',
            input.vault,
            input.vaultTopUp,
          ),
        );
      const clientUsdc = await sepolia.client.readContract({
        address: sepUsdc.address,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [input.client],
      });
      if (clientUsdc < input.clientSepoliaUsdcMin) {
        const f = await executeTransfer(sepolia, owner, {
          from: owner.address,
          to: input.client,
          amount: money(sepUsdc, input.clientSepoliaUsdcMin * 2n),
        });
        out.push({
          what: 'client Sepolia USDC',
          chain: 'eth-sepolia',
          hash: f.hash,
          explorer: f.explorer,
          arc: null,
        });
      }
      if (
        (await sepolia.client.getBalance({ address: input.client })) <
        parseEther('0.003')
      ) {
        const w = createWalletClient({
          account: owner,
          chain: sepoliaChain,
          transport: http(
            process.env[sepolia.profile.rpcEnvironment] ??
              sepolia.profile.rpcUrls[0],
          ),
        });
        const h = await w.sendTransaction({
          to: input.client,
          value: parseEther('0.01'),
        });
        await sepolia.client.waitForTransactionReceipt({ hash: h });
        out.push({
          what: 'client Sepolia ETH (gas)',
          chain: 'eth-sepolia',
          hash: h,
          explorer: `${sepolia.profile.explorer}/tx/${h}`,
          arc: null,
        });
      }
      return out;
    },
    cctpBurn: async (id, t: CctpTransfer) =>
      burnOnSource({
        chain: await sepoliaP,
        signer: client,
        transfer: t,
        onBurnHash: (h) => {
          send({ type: 'event', id, name: 'burnHash', value: h });
        },
      }),
    cctpMint: async (id, t: CctpTransfer, message: Hex, attestation: Hex) =>
      mintOnDestination({
        chain: await arcP,
        signer: owner,
        transfer: t,
        message,
        attestation,
        onMintHash: (h) => {
          send({ type: 'event', id, name: 'mintHash', value: h });
        },
      }),
  };

process.on('message', (m: WalletRequest) => {
  const op = ops[m.op];
  if (!op) {
    send({ type: 'result', id: m.id, ok: false, error: `unknown op ${m.op}` });
    return;
  }
  op(m.id, ...(m.args as never[])).then(
    (value) => send({ type: 'result', id: m.id, ok: true, value }),
    (e: Error & { code?: string }) =>
      send({
        type: 'result',
        id: m.id,
        ok: false,
        error: `${e.code ?? e.name}: ${e.message}`.slice(0, 400),
      }),
  );
});
process.on('disconnect', () => process.exit(0));
send({
  type: 'ready',
  owner: owner.address,
  client: client.address,
  sarah,
  walletB,
});
