/**
 * One real ERC-4337 UserOperation on Ethereum Sepolia whose gas is paid in
 * USDC through Circle Paymaster v0.8 (EntryPoint v0.8, EIP-7702 account).
 *
 *   node --import tsx scripts/paymaster-userop-proof.ts [--fund 1.5] [--send 0.01]
 *
 * Account: a fresh dedicated key in ~/.synq/paymaster-test.key (created here,
 * mode 600, never printed), delegated with EIP-7702 to the Simple7702Account
 * implementation. It holds no ETH: the bundler pays ETH and the paymaster
 * takes USDC under an EIP-2612 permit. The owner key only funds it with USDC.
 *
 * Also records: Arc refusal (no Circle Paymaster on Arc), wrong-EntryPoint
 * refusal, and the user-visible gas message for an ETH-less Sepolia EOA.
 * Output: bounty-evidence/arc/paymaster-userop-proof.json
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createPublicClient,
  encodeFunctionData,
  erc20Abi,
  hexToBigInt,
  http,
  keccak256,
  parseAbi,
  parseErc6492Signature,
  type Address,
  type Hex,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import {
  createBundlerClient,
  toSimple7702SmartAccount,
} from 'viem/account-abstraction';
import { sepolia } from 'viem/chains';
import { money, moneyFromDecimal, moneyToDecimal } from '@synq/domain';
import { chainProfile, contract, token } from '@synq/chain-registry/arc';
import { connectChain, executeTransfer } from '@synq/execution-worker/arc';
import {
  PAYMASTER_GAS,
  PaymasterError,
  accountUserOp,
  assertEntryPoint,
  encodePaymasterData,
  paymasterFor,
  paymasterPermitTypedData,
} from '@synq/plugin-circle-paymaster';
import { sourceGasRequirement } from '@synq/plugin-circle-gas';

const arg = (n: string, d: string) =>
  process.argv.includes(`--${n}`)
    ? process.argv[process.argv.indexOf(`--${n}`) + 1]!
    : d;
const j = (x: unknown) =>
  JSON.parse(
    JSON.stringify(x, (_, v) => (typeof v === 'bigint' ? v.toString() : v)),
  );
const readKey = (path: string) => {
  const k = readFileSync(path, 'utf8').trim();
  return (k.startsWith('0x') ? k : `0x${k}`) as Hex;
};

const home = `${process.env.HOME}/.synq`;
const testKeyPath = `${home}/paymaster-test.key`;
if (!existsSync(testKeyPath))
  writeFileSync(testKeyPath, generatePrivateKey(), { mode: 0o600, flag: 'wx' });
const smartOwner = privateKeyToAccount(readKey(testKeyPath));
const funder = privateKeyToAccount(readKey(`${home}/testnet.key`));
if (smartOwner.address === funder.address)
  throw new Error('test key must be fresh');

const CHAIN = 'eth-sepolia' as const;
const profile = chainProfile(CHAIN);
const route = paymasterFor(CHAIN, '0.8');
const usdc = token(CHAIN, 'USDC');
const fundAmount = moneyFromDecimal(usdc, arg('fund', '2'));
const sendAmount = moneyFromDecimal(usdc, arg('send', '0.01'));
const maxPermit = moneyFromDecimal(usdc, arg('permit', '2')).baseUnits;
if (maxPermit > fundAmount.baseUnits)
  throw new Error('permit above funded amount');
// Circle's quickstart uses 200k for paymaster validation; on Ethereum Sepolia
// (2026-10-16) the permit + oracle + transferFrom path measured ~312k, so the
// proof passes a measured limit (finding P16-20261016-paymaster-validation-gas).
const pmVerificationGas = BigInt(arg('pm-verification-gas', '360000'));
if (fundAmount.baseUnits > 2_000_000n) throw new Error('fund at most 2 USDC');
const bundlerUrl = `https://public.pimlico.io/v2/${profile.chainId}/rpc`;
const out: Record<string, unknown> = {
  label: 'LIVE_SEPOLIA',
  chain: CHAIN,
  paymasterVersion: route.version,
  paymaster: route.paymaster.address,
  entryPoint: route.entryPoint.address,
  bundler: bundlerUrl,
  smartAccount: smartOwner.address,
  smartAccountKind: 'EIP-7702 Simple7702Account (fresh dedicated key)',
  funder: funder.address,
  startedAt: new Date().toISOString(),
};
const dir = join(process.cwd(), '..', 'synq-v13', 'bounty-evidence', 'arc');
const save = () => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'paymaster-userop-proof.json'),
    JSON.stringify(j(out), null, 2),
  );
};

// 0. Scope refusals (P16-02) — no network needed.
const refusal = (fn: () => unknown) => {
  try {
    fn();
    return 'ACCEPTED';
  } catch (e) {
    return { code: (e as PaymasterError).code, message: (e as Error).message };
  }
};
out.arcRefusal = {
  'arc-testnet v0.8': refusal(() => paymasterFor('arc-testnet', '0.8')),
  'arc-testnet v0.7': refusal(() => paymasterFor('arc-testnet', '0.7')),
  'eth-sepolia v0.7 (not listed by Circle)': refusal(() =>
    paymasterFor('eth-sepolia', '0.7'),
  ),
};
const arc = await connectChain('arc-testnet');
out.arcPaymasterBytecode = {
  v08Address:
    (await arc.client.getCode({ address: route.paymaster.address })) ?? '0x',
  note: 'no Circle Paymaster code at the testnet paymaster addresses on Arc',
};

const chain = await connectChain(CHAIN);
const client = chain.client;

// 1. Verify paymaster/EntryPoint binding on chain and at the bundler (P16-03).
const pmAbi = parseAbi([
  'function entryPoint() view returns (address)',
  'function token() view returns (address)',
]);
const [pmEntryPoint, pmToken, epCode, pmCode, bundlerEps] = await Promise.all([
  client.readContract({
    address: route.paymaster.address,
    abi: pmAbi,
    functionName: 'entryPoint',
  }),
  client.readContract({
    address: route.paymaster.address,
    abi: pmAbi,
    functionName: 'token',
  }),
  client.getCode({ address: route.entryPoint.address }),
  client.getCode({ address: route.paymaster.address }),
  fetch(bundlerUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_supportedEntryPoints',
      params: [],
    }),
  }).then((r) => r.json() as Promise<{ result: Address[] }>),
]);
const observed = {
  entryPoint: route.entryPoint.address,
  paymasterEntryPoint: pmEntryPoint,
  paymasterToken: pmToken,
  entryPointCodeHash: keccak256(epCode!),
  paymasterCodeHash: keccak256(pmCode!),
  bundlerEntryPoints: bundlerEps.result,
};
assertEntryPoint(route, observed);
out.binding = observed;
out.wrongEntryPoint = refusal(() =>
  assertEntryPoint(route, {
    ...observed,
    entryPoint: contract(CHAIN, 'ERC4337_ENTRYPOINT_V07').address,
  }),
);

// 2. P16-06: what an ETH-less Sepolia EOA (the agent wallet, which holds no
//    Sepolia ETH) is told before a CCTP send. Sepolia's base fee is often a
//    few wei; the message prices gas at no less than 1 gwei so it never
//    understates what a wallet should hold.
const agentEoa = privateKeyToAccount(readKey(`${home}/arc-agent.key`)).address;
const fees = await client.estimateFeesPerGas();
const gasPrice = await client.getGasPrice();
const ONE_GWEI = 1_000_000_000n;
const feePerGas = [fees.maxFeePerGas ?? 0n, gasPrice, ONE_GWEI].reduce(
  (a, b) => (a > b ? a : b),
);
out.ethlessEoaMessage = {
  feePerGasUsed: feePerGas,
  networkMaxFeePerGas: fees.maxFeePerGas,
  ...sourceGasRequirement({
    chain: CHAIN,
    wallet: agentEoa,
    walletKind: 'EOA',
    nativeBalance: await client.getBalance({ address: agentEoa }),
    // approve (~60k) + depositForBurn (~180k)
    estimatedGasWei: 240_000n * feePerGas,
    action: 'send USDC to Arc via CCTP',
  }),
};
if (process.argv.includes('--message-only')) {
  const prior = JSON.parse(
    readFileSync(join(dir, 'paymaster-userop-proof.json'), 'utf8'),
  );
  prior.ethlessEoaMessage = j(out.ethlessEoaMessage);
  prior.ethlessEoaMessageAt = new Date().toISOString();
  writeFileSync(
    join(dir, 'paymaster-userop-proof.json'),
    JSON.stringify(prior, null, 2),
  );
  console.log(prior.ethlessEoaMessage);
  process.exit(0);
}

// 3. Fund the fresh account with USDC only (owner-signed ERC-20 transfer).
const usdcBal = (a: Address) =>
  client.readContract({
    address: usdc.address,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [a],
  });
// Funding is a top-up to `--fund` (default 2 USDC) so the account never
// receives more than that in total.
let accountUsdc = await usdcBal(smartOwner.address);
if (!process.argv.includes('--resume') && accountUsdc < fundAmount.baseUnits) {
  const topUp = money(usdc, fundAmount.baseUnits - accountUsdc);
  const funding = await executeTransfer(chain, funder, {
    from: funder.address,
    to: smartOwner.address,
    amount: topUp,
  });
  out.funding = {
    hash: funding.hash,
    amount: moneyToDecimal(topUp),
    explorer: funding.explorer,
  };
  accountUsdc = await usdcBal(smartOwner.address);
}
const ethBefore = await client.getBalance({ address: smartOwner.address });
if (ethBefore !== 0n)
  throw new Error('smart account must hold no ETH for this proof');

// 4. Account, permit and paymaster data.
const aaClient = createPublicClient({
  chain: sepolia,
  transport: http(process.env[profile.rpcEnvironment] ?? profile.rpcUrls[0]),
});
if ((await aaClient.getChainId()) !== profile.chainId)
  throw new Error('wrong chain');
const account = await toSimple7702SmartAccount({
  client: aaClient,
  owner: smartOwner,
});
if (
  account.entryPoint.address.toLowerCase() !==
  route.entryPoint.address.toLowerCase()
)
  throw new Error('account EntryPoint differs from the paymaster route');
const impl = contract(CHAIN, 'SIMPLE_7702_ACCOUNT');
const implCode = await client.getCode({ address: impl.address });
if (keccak256(implCode!) !== impl.codeHash)
  throw new Error('7702 implementation hash mismatch');
const usdcAbi = parseAbi([
  'function name() view returns (string)',
  'function version() view returns (string)',
  'function nonces(address) view returns (uint256)',
]);
const [tokenName, tokenVersion] = await Promise.all([
  client.readContract({
    address: usdc.address,
    abi: usdcAbi,
    functionName: 'name',
  }),
  client.readContract({
    address: usdc.address,
    abi: usdcAbi,
    functionName: 'version',
  }),
]);
const paymaster = {
  async getPaymasterData() {
    const nonce = await client.readContract({
      address: usdc.address,
      abi: usdcAbi,
      functionName: 'nonces',
      args: [account.address],
    });
    const typed = paymasterPermitTypedData({
      route,
      owner: account.address,
      value: maxPermit,
      nonce,
      tokenName,
      tokenVersion,
      maxPermit,
    });
    const wrapped = await account.signTypedData(typed);
    const { signature } = parseErc6492Signature(wrapped);
    return {
      paymaster: route.paymaster.address,
      paymasterData: encodePaymasterData({
        route,
        permitAmount: maxPermit,
        permitSignature: signature,
      }),
      paymasterVerificationGasLimit: pmVerificationGas,
      paymasterPostOpGasLimit: PAYMASTER_GAS.postOpGasLimit,
      isFinal: true,
    };
  },
};
const bundler = createBundlerClient({
  account,
  client: aaClient,
  paymaster,
  userOperation: {
    estimateFeesPerGas: async () => {
      const r = (await fetch(bundlerUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'pimlico_getUserOperationGasPrice',
          params: [],
        }),
      }).then((x) => x.json())) as {
        result: { standard: { maxFeePerGas: Hex; maxPriorityFeePerGas: Hex } };
      };
      return {
        maxFeePerGas: hexToBigInt(r.result.standard.maxFeePerGas),
        maxPriorityFeePerGas: hexToBigInt(
          r.result.standard.maxPriorityFeePerGas,
        ),
      };
    },
  },
  transport: http(bundlerUrl),
});

// 5. EIP-7702 authorization (only if not delegated yet) and the UserOperation.
const code = await client.getCode({ address: smartOwner.address });
const delegated =
  !!code &&
  code.toLowerCase() === `0xef0100${impl.address.slice(2).toLowerCase()}`;
const authorization = delegated
  ? undefined
  : await smartOwner.signAuthorization({
      chainId: profile.chainId,
      nonce: await client.getTransactionCount({ address: smartOwner.address }),
      contractAddress: impl.address,
    });
const usdcBefore = await usdcBal(smartOwner.address);
const recipientBefore = await usdcBal(funder.address);
out.permitCap = moneyToDecimal(money(usdc, maxPermit));
out.paymasterVerificationGasLimit = pmVerificationGas;
out.accountUsdcBeforeOp = usdcBefore;
save();
// `--resume <userOpHash>` re-reads an op an earlier run already submitted.
const resumeHash = process.argv.includes('--resume')
  ? (arg('resume', '') as Hex)
  : null;
let userOpHash: Hex;
if (resumeHash) userOpHash = resumeHash;
else
  try {
    userOpHash = await bundler.sendUserOperation({
      account,
      calls: [
        {
          to: usdc.address,
          data: encodeFunctionData({
            abi: erc20Abi,
            functionName: 'transfer',
            args: [funder.address, sendAmount.baseUnits],
          }),
        },
      ],
      authorization,
    });
  } catch (error) {
    out.result = 'USEROP_REJECTED';
    out.error = String(
      (error as { details?: string }).details ?? (error as Error).message,
    ).slice(0, 400);
    save();
    throw error;
  }
out.userOpHash = userOpHash;
save();
const receipt = await bundler.waitForUserOperationReceipt({
  hash: userOpHash,
  timeout: 420_000,
});
// Balances exactly around the bundle transaction, read at its block.
const opBlock = receipt.receipt.blockNumber;
const usdcAt = (a: Address, blockNumber: bigint) =>
  client.readContract({
    address: usdc.address,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [a],
    blockNumber,
  });
const [usdcBeforeOp, usdcAfter, recipientBeforeOp, recipientAfter, ethAfter] =
  await Promise.all([
    usdcAt(smartOwner.address, opBlock - 1n),
    usdcAt(smartOwner.address, opBlock),
    usdcAt(funder.address, opBlock - 1n),
    usdcAt(funder.address, opBlock),
    client.getBalance({ address: smartOwner.address, blockNumber: opBlock }),
  ]);
void usdcBefore;
void recipientBefore;

// 6. P16-04: fee accounted separately from the transfer, from logs only.
const acct = accountUserOp({
  route,
  logs: receipt.receipt.logs,
  sender: smartOwner.address,
  recipient: funder.address,
  userOpHash,
});
const spent = usdcBeforeOp - usdcAfter;
out.receipt = {
  success: receipt.success,
  txHash: receipt.receipt.transactionHash,
  block: receipt.receipt.blockNumber,
  bundlerEoa: receipt.receipt.from,
  explorer: `${profile.explorer}/tx/${receipt.receipt.transactionHash}`,
  userOpExplorer: `https://jiffyscan.xyz/userOpHash/${userOpHash}?network=sepolia`,
  delegatedInThisOp: !delegated,
};
out.accounting = {
  ...acct,
  transfer: moneyToDecimal(money(usdc, acct.transferAmount)),
  paymasterFeeUsdc: moneyToDecimal(money(usdc, acct.paymasterFee)),
  accountUsdcSpent: spent,
  spentEqualsTransferPlusFee: spent === acct.transferAmount + acct.paymasterFee,
  recipientReceived: recipientAfter - recipientBeforeOp,
  accountEthBefore: ethBefore,
  accountEthAfter: ethAfter,
};
if (
  !receipt.success ||
  acct.transferAmount !== sendAmount.baseUnits ||
  spent !== acct.transferAmount + acct.paymasterFee ||
  ethAfter !== 0n
)
  throw new Error('UserOperation did not reconcile');
out.result = 'SPONSORED_USEROP_RECONCILED';
out.finishedAt = new Date().toISOString();
save();
console.log(
  JSON.stringify(
    j({ receipt: out.receipt, accounting: out.accounting }),
    null,
    2,
  ),
);
