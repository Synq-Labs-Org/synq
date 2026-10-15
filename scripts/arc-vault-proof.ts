/**
 * Arc governed vault, milestone escrow and recovery: live proof on Arc testnet.
 *
 *   node --import tsx scripts/arc-vault-proof.ts deploy [--out-dir DIR]
 *   node --import tsx scripts/arc-vault-proof.ts prove  [--out-dir DIR]
 *   node --import tsx scripts/arc-vault-proof.ts sweep --safe 0x… [--out-dir DIR]
 *
 * `deploy` deploys SynqArcVaultFactory (which deploys its setup helper) and
 * SynqMilestoneEscrow from contracts/out (run `forge build` first) and writes
 * contracts/deployments/5042002.json. Their addresses and code hashes must
 * then be pinned in sources/arc_registry.json before `prove` will use them.
 *
 * `prove` verifies every address against its pinned code hash and then, on
 * chain: creates a 2-of-3 vault (canonical Safe v1.4.1 + SynqArcVaultPolicy),
 * funds it with 0.05 USDC, shows a 1-of-3 withdrawal fails (eth_call and a
 * real reverted tx), executes a 2-of-3 withdrawal signed by two independent
 * owner keys, shows the operator cannot add an owner or skip the timelock,
 * pays within the operator's scope, queues a timelocked change, pauses and
 * unpauses outflows, and runs a milestone escrow release and refund.
 *
 * Keys (testnet only, loaded from files, never printed): ~/.synq/testnet.key
 * (deployer, owner 1, guardian, relayer), ~/.synq/arc-client.key (owner 2,
 * escrow payer), ~/.synq/arc-contractor.key (owner 3, escrow payee, operator
 * recipient), ~/.synq/arc-agent.key (scoped operator, not an owner).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import {
  encodeDeployData,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  keccak256,
  parseEventLogs,
  toHex,
  type Abi,
  type Address,
  type Hex,
  type TransactionReceipt,
  type TransactionSerializableEIP1559,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { moneyFromDecimal, moneyToDecimal, money } from '@synq/domain';
import { contract, token, tokenEntry } from '@synq/chain-registry/arc';
import {
  balanceOf,
  connectChain,
  executeTransfer,
  verifyCode,
  type ArcChain,
} from '@synq/execution-worker/arc';
import { sendCall } from '@synq/execution-worker/cctp';
import {
  MILESTONE_ESCROW_ABI,
  OPERATION,
  SAFE_ABI,
  VAULT_FACTORY_ABI,
  VAULT_POLICY_ABI,
  collectSignatures,
  encodeExecTransaction,
  packSignatures,
  readVault,
  safeTxHash,
  simulate,
  verifySafeInfrastructure,
  type SafeTx,
  type SimResult,
} from '@synq/execution-worker/vault';

const mode = process.argv[2] ?? 'prove';
const arg = (n: string, d: string) =>
  process.argv.includes(`--${n}`)
    ? process.argv[process.argv.indexOf(`--${n}`) + 1]!
    : d;
const keyDir = process.env.SYNQ_KEY_DIR ?? `${process.env.HOME}/.synq`;
const load = (f: string) => {
  const k = readFileSync(join(keyDir, f), 'utf8').trim();
  return privateKeyToAccount((k.startsWith('0x') ? k : `0x${k}`) as Hex);
};
const deployer = load('testnet.key');
const client = load('arc-client.key');
const contractor = load('arc-contractor.key');
const agent = load('arc-agent.key');
type Signer = typeof deployer;

const chain = await connectChain('arc-testnet');
const usdc = token('arc-testnet', 'USDC');
const usdcCodeHash = await verifyCode(
  chain,
  usdc.address,
  tokenEntry(usdc).codeHash,
);
const units = (d: string) => moneyFromDecimal(usdc, d).baseUnits;
const dec = (u: bigint) => moneyToDecimal(money(usdc, u));
const explorer = (h: Hex) => `${chain.profile.explorer}/tx/${h}`;
const addrLink = (a: Address) => `${chain.profile.explorer}/address/${a}`;

// ---------------------------------------------------------------- tx helpers

async function feeFields(c: ArcChain) {
  const fees = await c.client.estimateFeesPerGas();
  const floor = c.profile.minMaxFeePerGasWei ?? 0n;
  const tip =
    fees.maxPriorityFeePerGas && fees.maxPriorityFeePerGas > 0n
      ? fees.maxPriorityFeePerGas
      : 1_000_000_000n;
  let max = fees.maxFeePerGas ?? 0n;
  if (max < floor) max = floor;
  if (max < tip) max = tip;
  return { maxFeePerGas: max * 2n, maxPriorityFeePerGas: tip };
}

/** Signs and broadcasts with an explicit gas limit (no estimation), so a call expected to revert can land on chain. */
async function sendRaw(
  signer: Signer,
  to: Address | undefined,
  data: Hex,
  gas?: bigint,
): Promise<{ hash: Hex; receipt: TransactionReceipt }> {
  if (!chain.profile.mutationEnabled) throw new Error('mutation disabled');
  const limit =
    gas ??
    ((await chain.client.estimateGas({ account: signer.address, to, data })) *
      130n) /
      100n;
  const nonce = await chain.client.getTransactionCount({
    address: signer.address,
    blockTag: 'pending',
  });
  const tx: TransactionSerializableEIP1559 & { chainId: number } = {
    type: 'eip1559',
    chainId: chain.profile.chainId,
    ...(to ? { to } : {}),
    data,
    value: 0n,
    gas: limit,
    nonce,
    ...(await feeFields(chain)),
  };
  const raw = await signer.signTransaction(tx);
  const hash = keccak256(raw);
  await chain.client.sendRawTransaction({ serializedTransaction: raw });
  const receipt = await chain.client.waitForTransactionReceipt({
    hash,
    confirmations: chain.profile.confirmations,
  });
  return { hash, receipt };
}

const steps: Record<string, unknown>[] = [];
function record(step: Record<string, unknown>) {
  steps.push(step);
  console.log(JSON.stringify(step));
}

async function tx(
  name: string,
  signer: Signer,
  to: Address,
  data: Hex,
): Promise<TransactionReceipt> {
  const hash = await sendCall(chain, signer, to, data, () => {});
  const receipt = await chain.client.getTransactionReceipt({ hash });
  record({
    step: name,
    mode: 'onchain-tx',
    from: signer.address,
    to,
    hash,
    block: String(receipt.blockNumber),
    status: receipt.status,
    gasUsed: String(receipt.gasUsed),
    explorer: explorer(hash),
  });
  return receipt;
}

function expectRevert(name: string, from: Address, r: SimResult, re: RegExp) {
  const reason = r.ok ? 'NO_REVERT' : r.reason;
  const pass = !r.ok && re.test(reason);
  record({ step: name, mode: 'eth_call', from, reverted: !r.ok, reason, pass });
  if (!pass) throw new Error(`${name}: expected ${re}, got ${reason}`);
}

function usdcTransfers(receipt: TransactionReceipt) {
  return parseEventLogs({
    abi: erc20Abi,
    logs: receipt.logs,
    eventName: 'Transfer',
  })
    .filter((l) => getAddress(l.address) === getAddress(usdc.address))
    .map((l) => ({
      from: l.args.from,
      to: l.args.to,
      value: l.args.value,
    }));
}

function artifact(name: string): { abi: Abi; bytecode: Hex } {
  const a = JSON.parse(
    readFileSync(
      resolve('contracts', 'out', `${name}.sol`, `${name}.json`),
      'utf8',
    ),
  ) as { abi: Abi; bytecode: { object: Hex } };
  return { abi: a.abi, bytecode: a.bytecode.object };
}

const codeHashOf = async (a: Address) =>
  keccak256((await chain.client.getCode({ address: a })) ?? '0x');

// ---------------------------------------------------------------- deploy

async function deploy() {
  const infra = await verifySafeInfrastructure(chain);
  const f = artifact('SynqArcVaultFactory');
  const e = artifact('SynqMilestoneEscrow');
  const factoryTx = await sendRaw(
    deployer,
    undefined,
    encodeDeployData({
      abi: f.abi,
      bytecode: f.bytecode,
      args: [
        infra.SAFE_L2_SINGLETON!.address,
        infra.SAFE_PROXY_FACTORY!.address,
        infra.SAFE_FALLBACK_HANDLER!.address,
        usdc.address,
      ],
    }),
  );
  const escrowTx = await sendRaw(
    deployer,
    undefined,
    encodeDeployData({
      abi: e.abi,
      bytecode: e.bytecode,
      args: [usdc.address],
    }),
  );
  if (
    factoryTx.receipt.status !== 'success' ||
    escrowTx.receipt.status !== 'success'
  )
    throw new Error('deployment reverted');
  const factory = getAddress(factoryTx.receipt.contractAddress!);
  const escrow = getAddress(escrowTx.receipt.contractAddress!);
  const setupHelper = await chain.client.readContract({
    address: factory,
    abi: parseSetupAbi,
    functionName: 'setupHelper',
  });
  const out = {
    chainId: chain.profile.chainId,
    deployer: deployer.address,
    gitCommit: execSync('git rev-parse HEAD').toString().trim(),
    compiler:
      'solc 0.8.28, cancun, optimizer 200, via-IR (contracts/foundry.toml)',
    safeVersion: '1.4.1',
    safeInfrastructure: infra,
    token: { address: usdc.address, codeHash: usdcCodeHash },
    SynqArcVaultFactory: {
      address: factory,
      codeHash: await codeHashOf(factory),
      tx: factoryTx.hash,
      block: String(factoryTx.receipt.blockNumber),
    },
    SynqArcVaultSetup: {
      address: setupHelper,
      codeHash: await codeHashOf(setupHelper),
      tx: factoryTx.hash,
    },
    SynqMilestoneEscrow: {
      address: escrow,
      codeHash: await codeHashOf(escrow),
      tx: escrowTx.hash,
      block: String(escrowTx.receipt.blockNumber),
    },
    upgradeAuthority:
      'none: factory, setup helper and escrow have no owner, proxy or admin',
  };
  const file = resolve('contracts', 'deployments', '5042002.json');
  writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
  console.log(JSON.stringify(out, null, 2));
  console.log(`deployment -> ${file}`);
}

const parseSetupAbi = [
  {
    type: 'function',
    name: 'setupHelper',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
] as const;

// ---------------------------------------------------------------- prove

async function prove() {
  const infra = await verifySafeInfrastructure(chain);
  const factoryEntry = contract('arc-testnet', 'SYNQ_ARC_VAULT_FACTORY');
  const escrowEntry = contract('arc-testnet', 'SYNQ_MILESTONE_ESCROW');
  const setupEntry = contract('arc-testnet', 'SYNQ_ARC_VAULT_SETUP');
  await verifyCode(chain, factoryEntry.address, factoryEntry.codeHash);
  await verifyCode(chain, escrowEntry.address, escrowEntry.codeHash);
  await verifyCode(chain, setupEntry.address, setupEntry.codeHash);
  const factory = factoryEntry.address;
  const escrow = escrowEntry.address;
  const read = <T>(
    address: Address,
    abi: Abi,
    functionName: string,
    args: unknown[] = [],
  ) =>
    chain.client.readContract({
      address,
      abi,
      functionName,
      args,
    }) as Promise<T>;
  // The factory must point at exactly the pinned Safe infrastructure and USDC.
  const bound = {
    safeSingleton: await read<Address>(
      factory,
      VAULT_FACTORY_ABI,
      'safeSingleton',
    ),
    safeProxyFactory: await read<Address>(
      factory,
      VAULT_FACTORY_ABI,
      'safeProxyFactory',
    ),
    fallbackHandler: await read<Address>(
      factory,
      VAULT_FACTORY_ABI,
      'fallbackHandler',
    ),
    token: await read<Address>(factory, VAULT_FACTORY_ABI, 'token'),
    escrowToken: await read<Address>(escrow, MILESTONE_ESCROW_ABI, 'token'),
  };
  if (
    bound.safeSingleton !== infra.SAFE_L2_SINGLETON!.address ||
    bound.safeProxyFactory !== infra.SAFE_PROXY_FACTORY!.address ||
    bound.fallbackHandler !== infra.SAFE_FALLBACK_HANDLER!.address ||
    getAddress(bound.token) !== getAddress(usdc.address) ||
    getAddress(bound.escrowToken) !== getAddress(usdc.address)
  )
    throw new Error(
      `factory/escrow bound to unexpected addresses: ${JSON.stringify(bound)}`,
    );

  // Preflight balances: tiny amounts only.
  const fund = units('0.05');
  const balances = async () => ({
    deployer: dec((await balanceOf(chain, usdc, deployer.address)).baseUnits),
    client: dec((await balanceOf(chain, usdc, client.address)).baseUnits),
    contractor: dec(
      (await balanceOf(chain, usdc, contractor.address)).baseUnits,
    ),
    agent: dec((await balanceOf(chain, usdc, agent.address)).baseUnits),
  });
  const before = await balances();
  for (const [who, min] of [
    ['deployer', '0.2'],
    ['client', '0.05'],
    ['contractor', '0.01'],
    ['agent', '0.01'],
  ] as const)
    if (units(before[who]) < units(min))
      throw new Error(`BLOCKED: ${who} has ${before[who]} USDC < ${min}`);

  // 1. Create a 2-of-3 vault. Owners are three independent keys; the agent is the scoped operator only.
  const salt = keccak256(toHex(`synq-arc-vault-proof:${Date.now()}`));
  const owners = [deployer.address, client.address, contractor.address];
  const params = {
    owners,
    threshold: 2n,
    guardian: deployer.address,
    operator: agent.address,
    delay: 3600n,
    recipients: [contractor.address],
    perPaymentCap: units('0.01'),
    windowCap: units('0.02'),
  };
  const created = await tx(
    'createVault',
    deployer,
    factory,
    encodeFunctionData({
      abi: VAULT_FACTORY_ABI,
      functionName: 'createVault',
      args: [params, salt],
    }),
  );
  const [ev] = parseEventLogs({
    abi: VAULT_FACTORY_ABI,
    logs: created.logs,
    eventName: 'VaultCreated',
  });
  if (!ev) throw new Error('no VaultCreated');
  const safe = getAddress(ev.args.safe);
  const policy = getAddress(ev.args.policy);
  const vault = await readVault(chain, safe);
  const singletonWord = await read<Hex>(safe, SAFE_ABI, 'getStorageAt', [
    0n,
    1n,
  ]);
  const vaultState = {
    vaultId: ev.args.vaultId,
    safe,
    policy,
    safeCodeHash: await codeHashOf(safe),
    policyCodeHash: await codeHashOf(policy),
    singleton: getAddress(`0x${singletonWord.slice(-40)}`),
    version: vault.version,
    owners: vault.owners,
    threshold: String(vault.threshold),
    guard: vault.guard,
    policyIsModule: vault.moduleEnabled,
    upgradeAuthority: await read<string>(
      policy,
      VAULT_POLICY_ABI,
      'UPGRADE_AUTHORITY',
    ),
    timelockDelaySeconds: String(
      await read<bigint>(policy, VAULT_POLICY_ABI, 'delay'),
    ),
    guardian: await read<Address>(policy, VAULT_POLICY_ABI, 'guardian'),
    operator: await read<Address>(policy, VAULT_POLICY_ABI, 'operator'),
    explorer: addrLink(safe),
  };
  if (
    vault.guard !== policy ||
    !vault.moduleEnabled ||
    vault.threshold !== 2n ||
    vault.version !== '1.4.1' ||
    vaultState.singleton !== infra.SAFE_L2_SINGLETON!.address
  )
    throw new Error(
      `vault not installed as expected: ${JSON.stringify(vaultState)}`,
    );
  record({ step: 'vaultState', ...vaultState });

  // 2. Fund with 0.05 USDC through the reconciled ERC-20 transfer path.
  const funding = await executeTransfer(chain, deployer, {
    from: deployer.address,
    to: safe,
    amount: money(usdc, fund),
  });
  record({
    step: 'fundVault',
    mode: 'onchain-tx',
    hash: funding.hash,
    amount: dec(fund),
    explorer: explorer(funding.hash),
  });

  const safeNonce = () => read<bigint>(safe, SAFE_ABI, 'nonce');
  const safeUsdc = async () => (await balanceOf(chain, usdc, safe)).baseUnits;
  const id = chain.profile.chainId;
  const usdcTransfer = (to: Address, amount: bigint) =>
    encodeFunctionData({
      abi: erc20Abi,
      functionName: 'transfer',
      args: [to, amount],
    });

  // 3. P07-01 negative: one owner's signature is below quorum.
  const withdrawal: SafeTx = {
    to: usdc.address,
    value: 0n,
    data: usdcTransfer(client.address, units('0.01')),
    operation: OPERATION.CALL,
    nonce: await safeNonce(),
  };
  const oneSig = packSignatures(
    await collectSignatures(id, safe, withdrawal, [contractor]),
  );
  const belowQuorum = encodeExecTransaction(withdrawal, oneSig);
  expectRevert(
    'P07-01 1-of-3 withdrawal (simulation)',
    deployer.address,
    await simulate(chain, deployer.address, safe, belowQuorum),
    /GS020/,
  );
  const nonceBefore = await safeNonce();
  const balanceBefore = await safeUsdc();
  const reverted = await sendRaw(deployer, safe, belowQuorum, 300_000n);
  const nonceAfter = await safeNonce();
  const balanceAfter = await safeUsdc();
  record({
    step: 'P07-01 1-of-3 withdrawal (real tx, explicit gas)',
    mode: 'onchain-tx-reverted',
    hash: reverted.hash,
    status: reverted.receipt.status,
    explorer: explorer(reverted.hash),
    safeNonceUnchanged: nonceAfter === nonceBefore,
    safeBalanceUnchanged: balanceAfter === balanceBefore,
    pass:
      reverted.receipt.status === 'reverted' &&
      nonceAfter === nonceBefore &&
      balanceAfter === balanceBefore,
  });
  if (reverted.receipt.status !== 'reverted')
    throw new Error('1-of-3 did not revert');

  // 4. P07-01 positive: two independent owner keys sign; a third party (deployer) only relays.
  const sigs = await collectSignatures(id, safe, withdrawal, [
    client,
    contractor,
  ]);
  const onchainHash = await read<Hex>(safe, SAFE_ABI, 'getTransactionHash', [
    withdrawal.to,
    withdrawal.value,
    withdrawal.data,
    withdrawal.operation,
    0n,
    0n,
    0n,
    '0x0000000000000000000000000000000000000000',
    '0x0000000000000000000000000000000000000000',
    withdrawal.nonce,
  ]);
  if (onchainHash !== safeTxHash(id, safe, withdrawal))
    throw new Error('SafeTx hash mismatch');
  const quorumData = encodeExecTransaction(withdrawal, packSignatures(sigs));
  const sim = await simulate(chain, deployer.address, safe, quorumData);
  if (!sim.ok) throw new Error(`2-of-3 simulation failed: ${sim.reason}`);
  const q = await tx('P07-01 2-of-3 withdrawal', deployer, safe, quorumData);
  const exec = parseEventLogs({
    abi: SAFE_ABI,
    logs: q.logs,
    eventName: 'ExecutionSuccess',
  });
  const moved = usdcTransfers(q);
  const quorumPass =
    exec.length === 1 &&
    exec[0]!.args.txHash === onchainHash &&
    moved.length === 1 &&
    getAddress(moved[0]!.from) === safe &&
    getAddress(moved[0]!.to) === client.address &&
    moved[0]!.value === units('0.01') &&
    (await safeNonce()) === withdrawal.nonce + 1n;
  record({
    step: 'P07-01 2-of-3 withdrawal checks',
    safeTxHash: onchainHash,
    signers: sigs.map((s) => s.owner),
    relayer: deployer.address,
    transfer: moved.map((m) => ({ ...m, value: dec(m.value) })),
    pass: quorumPass,
  });
  if (!quorumPass) throw new Error('2-of-3 withdrawal checks failed');

  // 5. P07-02: the operator cannot add an owner, queue governance, or count toward quorum.
  const addOwner = encodeFunctionData({
    abi: SAFE_ABI,
    functionName: 'addOwnerWithThreshold',
    args: [agent.address, 1n],
  });
  expectRevert(
    'P07-02 operator calls addOwnerWithThreshold directly',
    agent.address,
    await simulate(chain, agent.address, safe, addOwner),
    /GS031/,
  );
  const opReverted = await sendRaw(agent, safe, addOwner, 200_000n);
  record({
    step: 'P07-02 operator addOwnerWithThreshold (real tx, explicit gas)',
    mode: 'onchain-tx-reverted',
    hash: opReverted.hash,
    status: opReverted.receipt.status,
    explorer: explorer(opReverted.hash),
    agentIsOwner: await read<boolean>(safe, SAFE_ABI, 'isOwner', [
      agent.address,
    ]),
    pass:
      opReverted.receipt.status === 'reverted' &&
      !(await read<boolean>(safe, SAFE_ABI, 'isOwner', [agent.address])),
  });
  if (opReverted.receipt.status !== 'reverted')
    throw new Error('operator addOwner did not revert');
  expectRevert(
    'P07-02 operator queues addOwner on the policy',
    agent.address,
    await simulate(
      chain,
      agent.address,
      policy,
      encodeFunctionData({
        abi: VAULT_POLICY_ABI,
        functionName: 'queue',
        args: [safe, 0n, addOwner, 0],
      }),
    ),
    /NotSafe/,
  );
  const addOwnerTx: SafeTx = {
    to: safe,
    value: 0n,
    data: addOwner,
    operation: OPERATION.CALL,
    nonce: await safeNonce(),
  };
  const mixed = packSignatures(
    await collectSignatures(id, safe, addOwnerTx, [client, agent]),
  );
  expectRevert(
    'P07-02 operator + one owner sign addOwner',
    deployer.address,
    await simulate(
      chain,
      deployer.address,
      safe,
      encodeExecTransaction(addOwnerTx, mixed),
    ),
    /GS026/,
  );
  const lower: SafeTx = {
    to: safe,
    value: 0n,
    data: encodeFunctionData({
      abi: SAFE_ABI,
      functionName: 'changeThreshold',
      args: [1n],
    }),
    operation: OPERATION.CALL,
    nonce: await safeNonce(),
  };
  expectRevert(
    'P07-02 full quorum cannot lower threshold without timelock',
    deployer.address,
    await simulate(
      chain,
      deployer.address,
      safe,
      encodeExecTransaction(
        lower,
        packSignatures(
          await collectSignatures(id, safe, lower, [client, contractor]),
        ),
      ),
    ),
    /NotQueued/,
  );

  // 6. Scoped operator payment: allowlisted recipient, within cap.
  const ref = keccak256(toHex('synq-p07-operator-payment'));
  const paid = await tx(
    'P07-02 operator pays allowlisted recipient within cap',
    agent,
    policy,
    encodeFunctionData({
      abi: VAULT_POLICY_ABI,
      functionName: 'pay',
      args: [contractor.address, units('0.005'), ref],
    }),
  );
  const paidMoves = usdcTransfers(paid);
  if (
    paidMoves.length !== 1 ||
    getAddress(paidMoves[0]!.to) !== contractor.address ||
    paidMoves[0]!.value !== units('0.005')
  )
    throw new Error('operator payment mismatch');
  expectRevert(
    'P07-02 operator pays non-allowlisted recipient',
    agent.address,
    await simulate(
      chain,
      agent.address,
      policy,
      encodeFunctionData({
        abi: VAULT_POLICY_ABI,
        functionName: 'pay',
        args: [client.address, units('0.001'), ref],
      }),
    ),
    /RecipientNotAllowed/,
  );
  expectRevert(
    'P07-02 operator exceeds per-payment cap',
    agent.address,
    await simulate(
      chain,
      agent.address,
      policy,
      encodeFunctionData({
        abi: VAULT_POLICY_ABI,
        functionName: 'pay',
        args: [contractor.address, units('0.011'), ref],
      }),
    ),
    /CapExceeded/,
  );

  // 7. P07-07: governance change is queued by quorum and cannot run before the delay.
  const raise = encodeFunctionData({
    abi: SAFE_ABI,
    functionName: 'changeThreshold',
    args: [3n],
  });
  const queueTx: SafeTx = {
    to: policy,
    value: 0n,
    data: encodeFunctionData({
      abi: VAULT_POLICY_ABI,
      functionName: 'queue',
      args: [safe, 0n, raise, 0],
    }),
    operation: OPERATION.CALL,
    nonce: await safeNonce(),
  };
  const queued = await tx(
    'P07-07 quorum queues changeThreshold(3)',
    deployer,
    safe,
    encodeExecTransaction(
      queueTx,
      packSignatures(
        await collectSignatures(id, safe, queueTx, [deployer, client]),
      ),
    ),
  );
  const [qev] = parseEventLogs({
    abi: VAULT_POLICY_ABI,
    logs: queued.logs,
    eventName: 'OperationQueued',
  });
  if (!qev) throw new Error('no OperationQueued');
  const early: SafeTx = {
    to: safe,
    value: 0n,
    data: raise,
    operation: OPERATION.CALL,
    nonce: await safeNonce(),
  };
  expectRevert(
    'P07-07 quorum executes queued change before eta',
    deployer.address,
    await simulate(
      chain,
      deployer.address,
      safe,
      encodeExecTransaction(
        early,
        packSignatures(
          await collectSignatures(id, safe, early, [client, contractor]),
        ),
      ),
    ),
    /NotReady/,
  );
  record({
    step: 'P07-07 queued operation',
    id: qev.args.id,
    eta: String(qev.args.eta),
    delaySeconds: vaultState.timelockDelaySeconds,
  });

  // 8. P07-06: guardian pause freezes outflows only.
  await tx(
    'P07-06 guardian pause',
    deployer,
    policy,
    encodeFunctionData({ abi: VAULT_POLICY_ABI, functionName: 'pause' }),
  );
  const pausedOut: SafeTx = { ...withdrawal, nonce: await safeNonce() };
  expectRevert(
    'P07-06 quorum withdrawal while paused',
    deployer.address,
    await simulate(
      chain,
      deployer.address,
      safe,
      encodeExecTransaction(
        pausedOut,
        packSignatures(
          await collectSignatures(id, safe, pausedOut, [client, contractor]),
        ),
      ),
    ),
    /OutflowsPaused/,
  );
  expectRevert(
    'P07-06 operator payment while paused',
    agent.address,
    await simulate(
      chain,
      agent.address,
      policy,
      encodeFunctionData({
        abi: VAULT_POLICY_ABI,
        functionName: 'pay',
        args: [contractor.address, units('0.001'), ref],
      }),
    ),
    /OutflowsPaused/,
  );
  const cancelTx: SafeTx = {
    to: policy,
    value: 0n,
    data: encodeFunctionData({
      abi: VAULT_POLICY_ABI,
      functionName: 'cancel',
      args: [qev.args.id],
    }),
    operation: OPERATION.CALL,
    nonce: await safeNonce(),
  };
  const govWhilePaused = await simulate(
    chain,
    deployer.address,
    safe,
    encodeExecTransaction(
      cancelTx,
      packSignatures(
        await collectSignatures(id, safe, cancelTx, [client, contractor]),
      ),
    ),
  );
  record({
    step: 'P07-06 quorum governance call (cancel queued op) while paused',
    mode: 'eth_call',
    ok: govWhilePaused.ok,
    pass: govWhilePaused.ok,
  });
  if (!govWhilePaused.ok)
    throw new Error(`governance while paused failed: ${govWhilePaused.reason}`);
  expectRevert(
    'P07-06 guardian cannot add owner',
    deployer.address,
    await simulate(
      chain,
      deployer.address,
      safe,
      encodeFunctionData({
        abi: SAFE_ABI,
        functionName: 'addOwnerWithThreshold',
        args: [agent.address, 1n],
      }),
    ),
    /GS031/,
  );
  await tx(
    'P07-06 guardian unpause',
    deployer,
    policy,
    encodeFunctionData({ abi: VAULT_POLICY_ABI, functionName: 'unpause' }),
  );

  // 9. P07-03 / P07-05: milestone escrow release and refund.
  const m = units('0.01');
  await tx(
    'escrow approve',
    client,
    usdc.address,
    encodeFunctionData({
      abi: erc20Abi,
      functionName: 'approve',
      args: [escrow, 2n * m],
    }),
  );
  const latest = await chain.client.getBlock();
  const refundAfter = latest.timestamp + 75n;
  const opened = await tx(
    'escrow open (client funds 2 milestones for contractor)',
    client,
    escrow,
    encodeFunctionData({
      abi: MILESTONE_ESCROW_ABI,
      functionName: 'open',
      args: [
        contractor.address,
        '0x0000000000000000000000000000000000000000',
        refundAfter,
        keccak256(toHex('synq-p07-proof-terms-v1')),
        [m, m],
      ],
    }),
  );
  const [dev] = parseEventLogs({
    abi: MILESTONE_ESCROW_ABI,
    logs: opened.logs,
    eventName: 'DealOpened',
  });
  if (!dev) throw new Error('no DealOpened');
  const dealId = dev.args.dealId;
  const escrowCall = (fn: 'release' | 'withdraw' | 'refund', i: bigint) =>
    encodeFunctionData({
      abi: MILESTONE_ESCROW_ABI,
      functionName: fn,
      args: [dealId, i],
    });
  expectRevert(
    'P07-03 payee withdraws before release',
    contractor.address,
    await simulate(
      chain,
      contractor.address,
      escrow,
      escrowCall('withdraw', 0n),
    ),
    /WrongStatus\(1\)/,
  );
  expectRevert(
    'P07-03 payee releases its own milestone',
    contractor.address,
    await simulate(
      chain,
      contractor.address,
      escrow,
      escrowCall('release', 0n),
    ),
    /NotAuthorized/,
  );
  expectRevert(
    'P07-05 third party refunds before refundAfter',
    deployer.address,
    await simulate(chain, deployer.address, escrow, escrowCall('refund', 1n)),
    /RefundNotYetAllowed/,
  );
  await tx(
    'P07-03 payer releases milestone 0',
    client,
    escrow,
    escrowCall('release', 0n),
  );
  const w = await tx(
    'P07-03 payee withdraws milestone 0',
    contractor,
    escrow,
    escrowCall('withdraw', 0n),
  );
  const wm = usdcTransfers(w);
  if (
    wm.length !== 1 ||
    getAddress(wm[0]!.from) !== escrow ||
    getAddress(wm[0]!.to) !== contractor.address ||
    wm[0]!.value !== m
  )
    throw new Error('escrow withdraw mismatch');
  expectRevert(
    'P07-03 payee withdraws milestone 0 twice',
    contractor.address,
    await simulate(
      chain,
      contractor.address,
      escrow,
      escrowCall('withdraw', 0n),
    ),
    /WrongStatus\(3\)/,
  );
  for (;;) {
    const b = await chain.client.getBlock();
    if (b.timestamp >= refundAfter) break;
    await new Promise((r) => setTimeout(r, 5000));
  }
  const rf = await tx(
    'P07-05 third party triggers timeout refund of milestone 1',
    deployer,
    escrow,
    escrowCall('refund', 1n),
  );
  const rm = usdcTransfers(rf);
  const refundPass =
    rm.length === 1 &&
    getAddress(rm[0]!.from) === escrow &&
    getAddress(rm[0]!.to) === client.address &&
    rm[0]!.value === m;
  record({
    step: 'P07-05 refund went to original payer, not the caller',
    transfer: rm.map((x) => ({ ...x, value: dec(x.value) })),
    caller: deployer.address,
    pass: refundPass,
  });
  if (!refundPass) throw new Error('refund mismatch');
  expectRevert(
    'P07-05 refund claimed twice',
    client.address,
    await simulate(chain, client.address, escrow, escrowCall('refund', 1n)),
    /WrongStatus\(4\)/,
  );
  expectRevert(
    'P07-05 refunded milestone withdrawn by payee',
    contractor.address,
    await simulate(
      chain,
      contractor.address,
      escrow,
      escrowCall('withdraw', 1n),
    ),
    /WrongStatus\(4\)/,
  );
  const liability = await read<bigint>(
    escrow,
    MILESTONE_ESCROW_ABI,
    'totalLiability',
  );
  const escrowBalance = (await balanceOf(chain, usdc, escrow)).baseUnits;

  const after = await balances();
  const evidence = {
    kind: 'ARC_GOVERNED_VAULT_PROOF',
    environment: chain.profile.environment,
    chain: chain.profile.name,
    chainId: chain.profile.chainId,
    executedAt: new Date().toISOString(),
    gitCommit: execSync('git rev-parse HEAD').toString().trim(),
    custody:
      'Safe v1.4.1 (canonical Arc testnet deployment) + SynqArcVaultPolicy guard/module',
    safeInfrastructure: infra,
    token: {
      address: usdc.address,
      decimals: usdc.decimals,
      codeHash: usdcCodeHash,
    },
    factory: {
      address: factory,
      codeHash: factoryEntry.codeHash,
      explorer: addrLink(factory),
    },
    setupHelper: { address: setupEntry.address, codeHash: setupEntry.codeHash },
    escrow: {
      address: escrow,
      codeHash: escrowEntry.codeHash,
      explorer: addrLink(escrow),
      dealId: String(dealId),
      totalLiability: dec(liability),
      balance: dec(escrowBalance),
    },
    vault: vaultState,
    roles: {
      owners: {
        deployer: deployer.address,
        client: client.address,
        contractor: contractor.address,
      },
      threshold: 2,
      guardian: deployer.address,
      operator: agent.address,
      relayer: deployer.address,
    },
    balances: { before, after, vaultFinal: dec(await safeUsdc()) },
    steps,
  };
  const outDir = resolve(arg('out-dir', join('bounty-evidence', 'arc')));
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `vault-${q.transactionHash.slice(0, 10)}.json`);
  writeFileSync(file, JSON.stringify(evidence, null, 2) + '\n');
  console.log(`evidence -> ${file}`);
}

// ---------------------------------------------------------------- sweep

/** Recovers a factory vault's whole USDC balance to the deployer with two independent owner signatures. */
async function sweep() {
  const safe = getAddress(arg('safe', ''));
  const factoryEntry = contract('arc-testnet', 'SYNQ_ARC_VAULT_FACTORY');
  await verifyCode(chain, factoryEntry.address, factoryEntry.codeHash);
  const vault = await readVault(chain, safe);
  const policySafe = (await chain.client.readContract({
    address: vault.guard,
    abi: VAULT_POLICY_ABI,
    functionName: 'safe',
  })) as Address;
  if (getAddress(policySafe) !== safe || !vault.moduleEnabled)
    throw new Error('not a Synq Arc vault');
  const amount = (await balanceOf(chain, usdc, safe)).baseUnits;
  const t: SafeTx = {
    to: usdc.address,
    value: 0n,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: 'transfer',
      args: [deployer.address, amount],
    }),
    operation: OPERATION.CALL,
    nonce: vault.nonce,
  };
  const sigs = await collectSignatures(chain.profile.chainId, safe, t, [
    client,
    contractor,
  ]);
  const r = await tx(
    'sweep 2-of-3 vault balance to deployer',
    deployer,
    safe,
    encodeExecTransaction(t, packSignatures(sigs)),
  );
  const moved = usdcTransfers(r);
  record({
    step: 'sweep checks',
    safe,
    signers: sigs.map((s) => s.owner),
    transfer: moved.map((m) => ({ ...m, value: dec(m.value) })),
    pass:
      moved.length === 1 &&
      moved[0]!.value === amount &&
      (await balanceOf(chain, usdc, safe)).baseUnits === 0n,
  });
  const outDir = resolve(arg('out-dir', join('bounty-evidence', 'arc')));
  mkdirSync(outDir, { recursive: true });
  const file = join(
    outDir,
    `vault-sweep-${r.transactionHash.slice(0, 10)}.json`,
  );
  writeFileSync(
    file,
    JSON.stringify(
      {
        kind: 'ARC_GOVERNED_VAULT_SWEEP',
        chainId: chain.profile.chainId,
        steps,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(`evidence -> ${file}`);
}

if (mode === 'deploy') await deploy();
else if (mode === 'prove') await prove();
else if (mode === 'sweep') await sweep();
else throw new Error(`unknown mode ${mode}`);
