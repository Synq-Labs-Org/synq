import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  hashTypedData,
  keccak256,
  parseAbi,
  parseTransaction,
  recoverAddress,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { chainProfile } from '@synq/chain-registry/arc';
import {
  SAFE_ABI,
  VAULT_POLICY_ABI,
  safeTxTypedData,
} from '@synq/execution-worker/vault';
import type { ArcChain } from '@synq/execution-worker/arc';
import proxyCode from './fixtures/safe-proxy-code.json' with { type: 'json' };
const policyAbi = parseAbi([
  'function addRecipient(address recipient)',
  'function removeRecipient(address recipient)',
  'function setCaps(uint256 perPaymentCap,uint256 windowCap)',
  'event CapsChanged(uint256 perPaymentCap,uint256 windowCap)',
  'function queue(address to,uint256 value,bytes data,uint8 operation) returns(bytes32)',
  'event RecipientSet(address indexed recipient,bool allowed)',
]);
/** LOCAL_FIXTURE: independently enforces Safe signatures and the policy delay on real serialized bytes. */
export function fakeGovernanceChain(input: {
  safe: Address;
  policy: Address;
  owners: Address[];
  threshold: number;
  now: () => number;
  delay: number;
}) {
  let safeNonce = 0n,
    senderNonce = 0;
  let caps = { perPaymentCap: 5000000n, windowCap: 20000000n };
  const queued = new Map<Hex, number>(),
    allowed = new Set<string>(),
    receipts = new Map<Hex, Record<string, unknown>>();
  const broadcasts: Hex[] = [];
  const failure = { wait: 0 };
  const operationId = (data: Hex) =>
    keccak256(
      encodeAbiParameters(
        [
          { type: 'address' },
          { type: 'uint256' },
          { type: 'bytes32' },
          { type: 'uint8' },
        ],
        [input.policy, 0n, keccak256(data), 0],
      ),
    );
  const check = async (data: Hex, apply = false) => {
    const tx = decodeFunctionData({ abi: SAFE_ABI, data });
    if (tx.functionName !== 'execTransaction')
      throw new Error('not Safe execution');
    const [
      to,
      value,
      inner,
      operation,
      safeTxGas,
      baseGas,
      gasPrice,
      gasToken,
      refundReceiver,
      packed,
    ] = tx.args;
    if (
      to.toLowerCase() !== input.policy.toLowerCase() ||
      value !== 0n ||
      operation !== 0 ||
      safeTxGas !== 0n ||
      baseGas !== 0n ||
      gasPrice !== 0n ||
      BigInt(gasToken) !== 0n ||
      BigInt(refundReceiver) !== 0n
    )
      throw new Error('not bounded governance');
    const hash = hashTypedData(
      safeTxTypedData(chainProfile('arc-testnet').chainId, input.safe, {
        to,
        value,
        data: inner,
        operation,
        nonce: safeNonce,
      }),
    );
    const signers: Address[] = [];
    for (let i = 2; i < packed.length; i += 130) {
      const signature = `0x${packed.slice(i, i + 130)}` as Hex;
      const owner = await recoverAddress({ hash, signature });
      if (
        !input.owners.some((v) => v.toLowerCase() === owner.toLowerCase()) ||
        signers.some((v) => v.toLowerCase() === owner.toLowerCase())
      )
        throw new Error('invalid Safe signature');
      signers.push(owner);
    }
    if (signers.length < input.threshold) throw new Error('quorum missing');
    const action = decodeFunctionData({ abi: policyAbi, data: inner });
    const logs: { address: Address; topics: Hex[]; data: Hex }[] = [];
    if (action.functionName === 'queue') {
      const [target, v, call, op] = action.args;
      if (target !== input.policy || v !== 0n || op !== 0)
        throw new Error('wrong queue target');
      const id = operationId(call),
        eta = input.now() + input.delay;
      if (queued.has(id)) throw new Error('AlreadyQueued');
      if (apply) queued.set(id, eta);
      logs.push({
        address: input.policy,
        topics: encodeEventTopics({
          abi: VAULT_POLICY_ABI,
          eventName: 'OperationQueued',
          args: { id, to: input.policy },
        }) as Hex[],
        data: encodeAbiParameters(
          [
            { type: 'uint256' },
            { type: 'uint8' },
            { type: 'bytes' },
            { type: 'uint256' },
          ],
          [0n, 0, call, BigInt(eta)],
        ),
      });
    } else if (action.functionName === 'setCaps') {
      const id = operationId(inner),
        eta = queued.get(id);
      if (eta === undefined || input.now() < eta) throw new Error('NotReady');
      if (apply) {
        queued.delete(id);
        caps = { perPaymentCap: action.args[0], windowCap: action.args[1] };
      }
      logs.push({
        address: input.policy,
        topics: encodeEventTopics({
          abi: policyAbi,
          eventName: 'CapsChanged',
        }) as Hex[],
        data: encodeAbiParameters(
          [{ type: 'uint256' }, { type: 'uint256' }],
          [...action.args],
        ),
      });
    } else {
      const recipient = action.args[0];
      if (action.functionName === 'addRecipient') {
        const id = operationId(inner),
          eta = queued.get(id);
        if (eta === undefined || input.now() < eta) throw new Error('NotReady');
        if (apply) {
          queued.delete(id);
          allowed.add(recipient.toLowerCase());
        }
      } else if (apply) allowed.delete(recipient.toLowerCase());
      logs.push({
        address: input.policy,
        topics: encodeEventTopics({
          abi: policyAbi,
          eventName: 'RecipientSet',
          args: { recipient },
        }) as Hex[],
        data: encodeAbiParameters(
          [{ type: 'bool' }],
          [action.functionName === 'addRecipient'],
        ),
      });
    }
    if (apply) safeNonce++;
    logs.push({
      address: input.safe,
      topics: encodeEventTopics({
        abi: SAFE_ABI,
        eventName: 'ExecutionSuccess',
        args: { txHash: hash },
      }) as Hex[],
      data: encodeAbiParameters([{ type: 'uint256' }], [0n]),
    });
    return logs;
  };
  const client = {
    getChainId: async () => chainProfile('arc-testnet').chainId,
    getCode: async () => `0x${proxyCode.join('')}` as Hex,
    getBalance: async () => 10n ** 20n,
    getTransactionCount: async () => senderNonce,
    estimateFeesPerGas: async () => ({
      maxFeePerGas: 21_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
    }),
    estimateGas: async () => 90000n,
    call: async ({ data }: { data: Hex }) => {
      await check(data);
      return { data: encodeAbiParameters([{ type: 'bool' }], [true]) };
    },
    sendRawTransaction: async ({
      serializedTransaction,
    }: {
      serializedTransaction: Hex;
    }) => {
      const hash = keccak256(serializedTransaction);
      if (receipts.has(hash)) throw new Error('already known');
      const tx = parseTransaction(serializedTransaction);
      if (tx.nonce !== senderNonce) throw new Error('nonce mismatch');
      const logs = await check(tx.data!, true);
      broadcasts.push(hash);
      senderNonce++;
      receipts.set(hash, {
        status: 'success',
        blockNumber: 100n + BigInt(senderNonce),
        blockHash: `0x${'bb'.repeat(32)}`,
        gasUsed: 70000n,
        effectiveGasPrice: 21_000_000_000n,
        logs: logs.map((l, i) => ({
          ...l,
          logIndex: i,
          transactionIndex: 0,
          transactionHash: hash,
          blockHash: `0x${'bb'.repeat(32)}`,
          blockNumber: 100n + BigInt(senderNonce),
          removed: false,
        })),
      });
      return hash;
    },
    getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
      const r = receipts.get(hash);
      if (!r) throw new Error('not mined');
      return r;
    },
    waitForTransactionReceipt: async ({ hash }: { hash: Hex }) => {
      if (failure.wait-- > 0) throw new Error('receipt timeout');
      return client.getTransactionReceipt({ hash });
    },
  };
  return {
    chain: {
      profile: chainProfile('arc-testnet'),
      client: client as unknown as PublicClient,
    } satisfies ArcChain,
    broadcasts,
    failure,
    allowed,
    get caps() {
      return caps;
    },
    get safeNonce() {
      return safeNonce;
    },
  };
}
