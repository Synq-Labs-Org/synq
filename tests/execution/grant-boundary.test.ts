import { readFileSync } from 'node:fs';
import {
  concat,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  keccak256,
  parseTransaction,
  toEventSelector,
  toFunctionSelector,
  type AbiEvent,
  type AbiFunction,
  type TransactionSerializableEIP1559,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { officialAssets } from '../../packages/chain-registry/src/index.js';
import {
  chainGrant,
  observeGrantExecution,
  packSafeSignatures,
  prepareModuleCall,
  signGrantBoundTransaction,
  synqDeployment,
  testnetDeployment,
  EXECUTION_GRANT_TYPEHASH,
} from '../../workers/execution/src/index.js';
import {
  factoryAbi,
  moduleAbi,
  registryAbi,
  tokenAbi,
} from '../../workers/execution/src/abi.js';
import {
  MODULE,
  OPERATOR,
  RECIPIENT,
  asset,
  evidence,
  executedObservation,
  grantFor,
  harness,
  intent,
  mandate,
  now,
  owners,
} from '../kernel/fixtures.js';

const executor = privateKeyToAccount(`0x${'e'.repeat(64)}`);
const transfer = (to = RECIPIENT, amount = 60n) =>
  encodeFunctionData({
    abi: tokenAbi,
    functionName: 'transfer',
    args: [to, amount],
  });

async function issued(amount = 60n) {
  const data = transfer(RECIPIENT, amount);
  const input = evidence(
    intent({
      calldataHash: keccak256(data),
      operator: executor.address.toLowerCase(),
      maxInputAmount: String(amount),
    }),
  );
  const h = harness(input, [
    mandate({
      operators: [executor.address.toLowerCase()],
    }),
  ]);
  const { grant } = await grantFor(h, input);
  return { h, grant, input, data };
}
function tx(
  to: `0x${string}`,
  data: `0x${string}`,
): TransactionSerializableEIP1559 {
  return {
    type: 'eip1559',
    chainId: 31337,
    to,
    data,
    value: 0n,
    nonce: 0,
    gas: 500_000n,
    maxFeePerGas: 2n,
    maxPriorityFeePerGas: 1n,
  };
}

describe('execution boundary', () => {
  it('re-verifies the grant asset against the official registry and disables mainnet', async () => {
    const { grant } = await issued();
    expect(() => chainGrant(grant)).toThrow('ASSET_REGISTRY_MISMATCH');
    expect(chainGrant(grant, [asset]).token).toBe(asset.address);
    expect(() =>
      chainGrant({ ...grant, inputAsset: { ...asset, symbol: 'AUSD' } }, [
        asset,
      ]),
    ).toThrow('ASSET_REGISTRY_MISMATCH');
    const spoofed = { ...officialAssets.testnetAUSD, decimals: 18 };
    expect(() =>
      chainGrant({ ...grant, chainId: 10143, inputAsset: spoofed }),
    ).toThrow();
    expect(() => chainGrant({ ...grant, chainId: 143 })).toThrow();
  });

  it('packs Safe signatures sorted by owner and refuses malformed approval sets', async () => {
    const { grant } = await issued();
    const packed = packSafeSignatures(grant.approvals, grant.draft);
    const sorted = [...grant.approvals].sort((a, b) =>
      a.signer < b.signer ? -1 : 1,
    );
    expect(packed).toBe(concat(sorted.map((a) => a.signature)));
    expect(
      packSafeSignatures([...grant.approvals].reverse(), grant.draft),
    ).toBe(packed);
    expect(() =>
      packSafeSignatures(grant.approvals.slice(0, 1), grant.draft),
    ).toThrow('SIGNATURE_PACKING_INVALID');
    expect(() =>
      packSafeSignatures(
        [grant.approvals[0]!, grant.approvals[0]!],
        grant.draft,
      ),
    ).toThrow('SIGNATURE_PACKING_INVALID');
    expect(() =>
      packSafeSignatures(
        grant.approvals.map((a) => ({
          ...a,
          draftDigest: `0x${'1'.repeat(64)}` as const,
        })),
        grant.draft,
      ),
    ).toThrow('SIGNATURE_PACKING_INVALID');
  });

  it('S8: preparation requires this worker’s claim and happens once', async () => {
    const { h, grant, input, data } = await issued();
    expect(() =>
      prepareModuleCall(
        h.kernel,
        {
          grantId: grant.grantId,
          workerId: 'x',
          claimId: grant.grantId,
          claimedAt: now,
        },
        data,
        [asset],
      ),
    ).toThrow('GRANT_CLAIM_INVALID');
    const claim = h.kernel.claimForExecution(grant, input.intent, 'worker');
    const call = prepareModuleCall(h.kernel, claim, data, [asset]);
    expect(call.to).toBe(MODULE);
    expect(() => prepareModuleCall(h.kernel, claim, data, [asset])).toThrow(
      'GRANT_NOT_PREPARABLE',
    );
  });

  it('§38 signGrantBoundTransaction signs only a transaction inside the grant with the executor key', async () => {
    const { h, grant, input, data } = await issued();
    const claim = h.kernel.claimForExecution(grant, input.intent, 'worker');
    const call = prepareModuleCall(h.kernel, claim, data, [asset]);
    const raw = await signGrantBoundTransaction(
      grant,
      tx(call.to, call.data),
      executor,
      now,
      [asset],
    );
    expect(parseTransaction(raw).to?.toLowerCase()).toBe(MODULE);
    const refused = async (
      prepared: TransactionSerializableEIP1559,
      signer = executor,
      at = now,
    ) =>
      expect(
        signGrantBoundTransaction(grant, prepared, signer, at, [asset]),
      ).rejects.toThrow('GRANT_SIGNING_REFUSED');
    await refused({ ...tx(call.to, call.data), chainId: 10143 });
    await refused(tx(`0x${'1'.repeat(40)}`, call.data));
    await refused({ ...tx(call.to, call.data), value: 1n });
    await refused(tx(call.to, call.data), owners[0]!);
    await refused(tx(call.to, call.data), executor, grant.validUntil);
    const g = chainGrant(grant, [asset]);
    const sigs = packSafeSignatures(grant.approvals, grant.draft);
    const encode = (
      grantArgs: typeof g,
      inner: `0x${string}`,
      signatures = sigs,
    ) =>
      encodeFunctionData({
        abi: moduleAbi,
        functionName: 'execute',
        args: [grantArgs, inner, signatures],
      });
    await refused(
      tx(call.to, encode({ ...g, recipient: `0x${'6'.repeat(40)}` }, data)),
    );
    await refused(tx(call.to, encode({ ...g, maxInputAmount: 61n }, data)));
    await refused(
      tx(call.to, encode({ ...g, account: `0x${'6'.repeat(40)}` }, data)),
    );
    await refused(tx(call.to, encode(g, transfer(`0x${'6'.repeat(40)}`))));
    await refused(tx(call.to, encode(g, transfer(RECIPIENT, 61n))));
    await refused(tx(call.to, encode(g, data, concat([sigs, sigs]))));
    expect(executor.address.toLowerCase()).toBe(grant.operator);
    expect(OPERATOR).not.toBe(grant.operator);
  });

  it('decodes a GrantExecuted receipt into the reconciliation observation', async () => {
    const { grant } = await issued();
    const observation = executedObservation(grant);
    const e = observation.event;
    const topics = encodeEventTopics({
      abi: moduleAbi,
      eventName: 'GrantExecuted',
      args: {
        groupId: e.groupId,
        intentHash: e.intentHash,
        mandateId: e.mandateId,
      },
    });
    const types = [
      'uint256',
      'address',
      'address',
      'bytes32',
      'uint256',
      'uint256',
      'bytes32',
      'address',
      'bytes4',
      'bytes32',
      'address',
      'address',
      'uint256',
      'uint256',
      'uint256',
    ].map((type) => ({ type }));
    const data = encodeAbiParameters(types, [
      BigInt(e.mandateVersion),
      e.account,
      e.executor,
      e.pluginId,
      BigInt(e.chainId),
      BigInt(e.nonce),
      e.grantHash,
      e.target,
      e.selector,
      e.calldataHash,
      e.token,
      e.recipient,
      BigInt(e.tokenAmount),
      BigInt(e.nativeValue),
      BigInt(e.outputAmount),
    ]);
    const decoded = observeGrantExecution(
      {
        status: 'success',
        transactionHash: observation.transactionHash,
        blockNumber: 101n,
        logs: [{ address: MODULE, data, topics: topics as `0x${string}`[] }],
      },
      MODULE,
      31337,
    );
    expect(decoded).toEqual(observation);
    expect(
      observeGrantExecution(
        {
          status: 'reverted',
          transactionHash: observation.transactionHash,
          blockNumber: 101n,
          logs: [],
        },
        MODULE,
        31337,
      ),
    ).toMatchObject({ receiptStatus: 'reverted', event: null });
  });

  it('worker ABIs match the generated contract ABIs exactly', () => {
    const json = (name: string) =>
      JSON.parse(readFileSync(`contracts/abi/${name}.json`, 'utf8')) as (
        | AbiFunction
        | AbiEvent
      )[];
    for (const [name, abi] of [
      ['ExecutionModule', moduleAbi],
      ['MandateRegistry', registryAbi],
      ['SynqGroupFactory', factoryAbi],
    ] as const) {
      const reference = json(name);
      for (const item of abi) {
        if (item.type === 'function') {
          const ref = reference.find(
            (r) => r.type === 'function' && r.name === item.name,
          );
          expect(ref, `${name}.${item.name}`).toBeDefined();
          expect(toFunctionSelector(item)).toBe(
            toFunctionSelector(ref as AbiFunction),
          );
        }
        if (item.type === 'event') {
          const ref = reference.find(
            (r) => r.type === 'event' && r.name === item.name,
          );
          expect(ref, `${name}.${item.name}`).toBeDefined();
          expect(toEventSelector(item)).toBe(toEventSelector(ref as AbiEvent));
        }
      }
    }
  });

  it('local uses runtime addresses; testnet loads the recorded deployment manifest and checks registry drift', () => {
    const testnet = synqDeployment('sandbox/monad-testnet');
    expect(testnet).toMatchObject({
      chainId: 10143,
      source: 'contracts/deployments/10143.json',
    });
    const raw = JSON.parse(
      readFileSync('contracts/deployments/10143.json', 'utf8'),
    );
    expect(raw.grantTypehash).toBe(EXECUTION_GRANT_TYPEHASH);
    expect(() =>
      testnetDeployment({ ...raw, grantTypehash: `0x${'1'.repeat(64)}` }),
    ).toThrow('DEPLOYMENT_MANIFEST_INVALID');
    expect(() =>
      testnetDeployment({ ...raw, safeL2Singleton: `0x${'2'.repeat(40)}` }),
    ).toThrow('DEPLOYMENT_MANIFEST_INVALID');
    expect(() => synqDeployment('local/anvil')).toThrow(
      'DEPLOYMENT_MANIFEST_INVALID',
    );
    expect(() => synqDeployment('proof/monad-mainnet')).toThrow(
      'DEPLOYMENT_MANIFEST_INVALID',
    );
    expect(
      synqDeployment('local/anvil', {
        factory: MODULE,
        registry: MODULE,
        module: MODULE,
      }),
    ).toMatchObject({ chainId: 31337, source: 'runtime-local' });
  });
});
