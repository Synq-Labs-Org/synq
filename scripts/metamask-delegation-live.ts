// Live Monad testnet proof for MetaMaskDelegationAdapter (programmatic ERC-7710 delegation, not ERC-7715).
// Member = fresh test EOA upgraded to the kit's EIP7702StatelessDeleGator; delegate = operator test wallet.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { profileConfiguration } from '@synq/chain-registry';
import {
  MetaMaskDelegationAdapter,
  decodeRevertReason,
  type Delegation,
  type RecurringContributionPolicy,
} from '@synq/metamask-delegation';
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  erc20Abi,
  formatUnits,
  getAddress,
  http,
  keccak256,
  parseAbi,
  parseEther,
  parseEventLogs,
  toHex,
  type Address,
  type Hex,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const profile = profileConfiguration('sandbox/monad-testnet');
const chainId = profile.network.chainId;
const rpc = process.env.SYNQ_MONAD_TESTNET_RPC_URL ?? profile.defaultRpcUrl;
const chain = defineChain({
  id: chainId,
  name: 'Monad Testnet',
  nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: [rpc] } },
});
const deployments = JSON.parse(
  readFileSync(join('contracts', 'deployments', `${chainId}.json`), 'utf8'),
);
const GROUP_ID = (process.env.SYNQ_MM_DELEGATION_GROUP ??
  '0x8241ac62ee0888e2065225c17e29cf9c6245069c89c687d2da44aae40811c1ec') as Hex;
const AUSD_UNIT = 1_000_000n;

const readKey = (file: string) => {
  const text = readFileSync(file, 'utf8').trim();
  return (text.startsWith('0x') ? text : `0x${text}`) as Hex;
};

async function main() {
  if (process.env.SYNQ_ALLOW_MAINNET_BROADCAST === 'true')
    throw new Error('refusing: mainnet broadcast flag is set');
  const operatorFile = process.env.SYNQ_TESTNET_KEY_FILE;
  if (!operatorFile) throw new Error('SYNQ_TESTNET_KEY_FILE required');
  const operator = privateKeyToAccount(readKey(operatorFile));
  if (operator.address !== getAddress(deployments.deployer))
    throw new Error('operator key is not the registered test deployer');
  const memberFile =
    process.env.SYNQ_MM_MEMBER_KEY_FILE ??
    join(homedir(), '.synq', 'mm-delegation-member.key');
  if (!existsSync(memberFile)) {
    mkdirSync(dirname(memberFile), { recursive: true, mode: 0o700 });
    writeFileSync(memberFile, generatePrivateKey(), { mode: 0o600 });
  }
  chmodSync(memberFile, 0o600);
  const member = privateKeyToAccount(readKey(memberFile));

  const pub = createPublicClient({ chain, transport: http(rpc) });
  const op = createWalletClient({
    account: operator,
    chain,
    transport: http(rpc),
  });
  const mem = createWalletClient({
    account: member,
    chain,
    transport: http(rpc),
  });
  if ((await pub.getChainId()) !== chainId)
    throw new Error('RPC chain mismatch');

  const adapter = new MetaMaskDelegationAdapter(chainId);
  const ausd = adapter.token;
  const safe = getAddress(
    await pub.readContract({
      address: deployments.MandateRegistry,
      abi: parseAbi(['function accountOf(bytes32) view returns (address)']),
      functionName: 'accountOf',
      args: [GROUP_ID],
    }),
  );
  const balance = (a: Address) =>
    pub.readContract({
      address: ausd,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [a],
    });
  const evidence: Record<string, unknown> = {
    mode: 'REAL_TESTNET',
    chainId,
    delegationManager: adapter.delegationManager,
    enforcers: adapter.environment.caveatEnforcers,
    implementation:
      adapter.environment.implementations.EIP7702StatelessDeleGatorImpl,
    member: member.address,
    delegate: operator.address,
    groupId: GROUP_ID,
    safe,
    token: ausd,
    steps: [] as unknown[],
  };
  const steps = evidence.steps as unknown[];
  const log = (step: Record<string, unknown>) => {
    steps.push(step);
    console.log(
      JSON.stringify(step, (_k, v) =>
        typeof v === 'bigint' ? v.toString() : v,
      ),
    );
  };
  const wait = async (hash: Hex) => {
    const r = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
    return { hash, status: r.status, block: r.blockNumber, receipt: r };
  };

  // 1. fund the test member (testnet only, small amounts)
  if ((await pub.getBalance({ address: member.address })) < parseEther('0.2')) {
    const r = await wait(
      await op.sendTransaction({
        to: member.address,
        value: parseEther('0.5'),
      }),
    );
    log({ step: 'fund-member-mon', tx: r.hash, status: r.status });
  }
  if ((await balance(member.address)) < 2n * AUSD_UNIT) {
    const r = await wait(
      await op.writeContract({
        address: ausd,
        abi: erc20Abi,
        functionName: 'transfer',
        args: [member.address, 3n * AUSD_UNIT],
      }),
    );
    log({ step: 'fund-member-ausd', tx: r.hash, status: r.status });
  }

  // 2. EIP-7702: member EOA delegates its code to the kit's stateless DeleGator
  const impl = getAddress(
    adapter.environment.implementations.EIP7702StatelessDeleGatorImpl!,
  );
  const designator = `0xef0100${impl.slice(2).toLowerCase()}`;
  const code = (await pub.getCode({ address: member.address }))?.toLowerCase();
  if (code !== designator) {
    const authorization = await mem.signAuthorization({
      contractAddress: impl,
    });
    const r = await wait(
      await op.sendTransaction({
        to: member.address,
        data: '0x',
        authorizationList: [authorization],
      }),
    );
    const after = (
      await pub.getCode({ address: member.address })
    )?.toLowerCase();
    log({
      step: 'eip7702-upgrade',
      tx: r.hash,
      status: r.status,
      codeIsDesignator: after === designator,
    });
    if (after !== designator)
      throw new Error('EIP-7702 upgrade did not take effect');
  } else log({ step: 'eip7702-upgrade', alreadyUpgraded: true });

  // 3. delegation: up to 1 AUSD per week to the group Safe until 2026-12-31, 1.5 AUSD total, 3 calls
  const block = await pub.getBlock();
  const now = Number(block.timestamp);
  const policy: RecurringContributionPolicy = {
    chainId,
    token: ausd,
    delegator: member.address,
    delegate: operator.address,
    safe,
    perPeriodAmount: 1n * AUSD_UNIT,
    periodSeconds: 7 * 86_400,
    startDate: now - 60,
    cumulativeCap: (3n * AUSD_UNIT) / 2n,
    maxExecutions: 3,
    validAfter: now - 120,
    validUntil: Math.floor(Date.UTC(2026, 11, 31, 23, 59, 59) / 1000),
    salt: keccak256(toHex(`synq-mm-delegation-${now}`)),
  };
  const limits = {
    safe,
    maxPerPeriod: 20n * AUSD_UNIT,
    maxCumulative: 100n * AUSD_UNIT,
    latestValidUntil: policy.validUntil,
  };
  const unsigned = adapter.buildDelegation(policy, limits);
  const signed: Delegation = {
    ...unsigned,
    signature: await member.signTypedData(
      adapter.delegationTypedData(unsigned),
    ),
  };
  const delegationHash = adapter.verifyDelegation(signed, policy, limits);
  log({
    step: 'delegation-created',
    delegationHash,
    caveats: signed.caveats.length,
    validUntil: policy.validUntil,
  });

  const transfer = (to: Address, amount: bigint) =>
    encodeFunctionData({
      abi: erc20Abi,
      functionName: 'transfer',
      args: [to, amount],
    });
  const simulate = async (data: Hex) => {
    try {
      await pub.call({
        account: operator.address,
        to: adapter.delegationManager,
        data,
      });
      return { ok: true as const };
    } catch (error) {
      const reason = decodeRevertReason(error);
      return {
        ok: false as const,
        reason:
          reason && reason.errorName !== 'Error'
            ? reason.errorName
            : (reason?.message ?? (error as Error).message.slice(0, 200)),
      };
    }
  };
  const broadcastExpectingRevert = async (data: Hex) => {
    const r = await wait(
      await op.sendTransaction({
        to: adapter.delegationManager,
        data,
        gas: 400_000n,
      }),
    );
    return { tx: r.hash, status: r.status };
  };

  // 4. bounded contribution through the delegation
  const safeBefore = await balance(safe);
  const first = adapter.planContribution(
    signed,
    policy,
    {
      amount: (6n * AUSD_UNIT) / 10n,
      nowSeconds: now,
      spentThisPeriod: 0n,
      spentTotal: 0n,
    },
    limits,
  );
  const r1 = await wait(
    await op.sendTransaction({ to: first.to, data: first.data }),
  );
  const moved = parseEventLogs({
    abi: erc20Abi,
    eventName: 'Transfer',
    logs: r1.receipt.logs,
  }).find(
    (l) =>
      getAddress(l.address) === ausd &&
      getAddress(l.args.from) === member.address &&
      getAddress(l.args.to) === safe,
  );
  log({
    step: 'contribution-1',
    tx: r1.hash,
    status: r1.status,
    amount: moved ? formatUnits(moved.args.value, 6) : null,
    safeDelta: formatUnits((await balance(safe)) - safeBefore, 6),
  });
  if (r1.status !== 'success' || !moved)
    throw new Error('bounded contribution failed');

  // 5. period allowance is enforced on-chain (0.6 + 0.6 > 1 AUSD per week)
  let offline: string | null = null;
  try {
    adapter.planContribution(
      signed,
      policy,
      {
        amount: (6n * AUSD_UNIT) / 10n,
        nowSeconds: now,
        spentThisPeriod: (6n * AUSD_UNIT) / 10n,
        spentTotal: (6n * AUSD_UNIT) / 10n,
      },
      limits,
    );
  } catch (e) {
    offline = (e as { code?: string }).code ?? 'ERROR';
  }
  const over = adapter.encodeRedemption(signed, {
    target: ausd,
    callData: transfer(safe, (6n * AUSD_UNIT) / 10n),
  });
  log({
    step: 'allowance-enforced',
    offlineCheck: offline,
    simulation: await simulate(over.data),
    onchain: await broadcastExpectingRevert(over.data),
  });

  // 6. unauthorized destination is rejected on-chain even within the allowance
  const rogue = adapter.encodeRedemption(signed, {
    target: ausd,
    callData: transfer(operator.address, AUSD_UNIT / 10n),
  });
  log({
    step: 'unauthorized-destination',
    simulation: await simulate(rogue.data),
    onchain: await broadcastExpectingRevert(rogue.data),
  });

  // 7. a small valid contribution still simulates fine before revocation
  const valid = adapter.encodeRedemption(signed, {
    target: ausd,
    callData: transfer(safe, AUSD_UNIT / 10n),
  });
  const preRevoke = await simulate(valid.data);
  log({ step: 'pre-revoke-valid-simulation', simulation: preRevoke });

  // 8. member revokes
  const revoke = adapter.revocation(signed);
  const rv = await wait(
    await mem.sendTransaction({ to: revoke.to, data: revoke.data }),
  );
  const disabled = await pub.readContract({
    address: adapter.delegationManager,
    abi: parseAbi([
      'function disabledDelegations(bytes32) view returns (bool)',
    ]),
    functionName: 'disabledDelegations',
    args: [delegationHash],
  });
  log({ step: 'revoked', tx: rv.hash, status: rv.status, disabled });

  // 9. the same valid contribution now fails
  log({
    step: 'post-revoke-execution',
    simulation: await simulate(valid.data),
    onchain: await broadcastExpectingRevert(valid.data),
  });

  evidence.safeBalance = formatUnits(await balance(safe), 6);
  evidence.memberBalance = formatUnits(await balance(member.address), 6);
  evidence.explorer = profile.explorerUrl;
  const out = join('bounty-evidence', 'metamask', 'delegation-live.json');
  writeFileSync(
    out,
    `${JSON.stringify(evidence, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2)}\n`,
  );
  console.log(`evidence written to ${out}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
