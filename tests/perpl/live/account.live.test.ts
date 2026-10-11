import { describe, expect, it } from 'vitest';
import { parseEther } from 'viem';
import {
  monadTestnetProfile,
  officialAsset,
  perplNetwork,
} from '@synq/chain-registry';
import { PerplCollateralAdapter, PerplRestClient } from '@synq/plugin-perpl';
import {
  EnrollmentError,
  OPERATOR_ACCOUNT_LABEL,
  connectOperator,
  defaultKeyPath,
  enrollApiKey,
  keyFileExists,
  loadOperatorAccount,
} from '@synq/perpl-executor';
import { LIVE, readEvidence, recordEvidence } from './evidence.js';

const network = perplNetwork('sandbox/monad-testnet');

describe.skipIf(!LIVE)('REAL_TESTNET Perpl operator account', () => {
  it('creates the test-harness account, enables forwarding and attempts key enrollment', async () => {
    const rest = new PerplRestClient({ network });
    const context = await rest.context();
    const collateral = new PerplCollateralAdapter(network).resolve(context);
    expect(collateral.address).toBe(officialAsset('testnetAUSD').address);
    const operator = await connectOperator(network, loadOperatorAccount(), {
      maxSpendWei: parseEther('0.3'),
    });
    const startNative = await operator.nativeBalance();
    const previous = readEvidence('testnet-account');
    let account = await operator.exchangeAccount();
    let createdTx: string | null = null;
    let approveTx: string | null = null;
    let faucetTx: string | null = null;
    if (!account) {
      if ((await operator.collateralBalance()) < collateral.minAccountOpen) {
        const faucet = monadTestnetProfile.faucetAddress;
        if (!faucet) throw new Error('registry has no AUSD faucet');
        faucetTx = (await operator.faucet(faucet)).transactionHash;
      }
      approveTx =
        (await operator.approveExact(collateral.minAccountOpen))
          ?.transactionHash ?? null;
      const created = await operator.createAccount(collateral.minAccountOpen);
      createdTx = created.receipt.transactionHash;
      account = await operator.exchangeAccount();
    }
    expect(account).not.toBeNull();
    let forwardingTx =
      typeof previous?.forwardingTx === 'string' ? previous.forwardingTx : null;
    let forwardingEvent: unknown = previous?.forwardingEvent ?? null;
    if (!forwardingTx) {
      const fw = await operator.allowOrderForwarding(true);
      forwardingTx = fw.receipt.transactionHash;
      forwardingEvent = fw.event;
    }
    const enrollment: Record<string, unknown> = {};
    for (const scope of ['read', 'trade'] as const) {
      const keyPath = defaultKeyPath(scope);
      if (keyFileExists(keyPath)) {
        const earlier = (
          previous?.enrollment as Record<string, unknown> | undefined
        )?.[scope];
        enrollment[scope] = earlier ?? { status: 'KEY_FILE_PRESENT' };
        continue;
      }
      try {
        const result = await enrollApiKey({
          network,
          address: operator.address,
          scope,
          label: `synq-p10-${scope}`,
          signTypedData: operator.signTypedData,
          keyPath,
        });
        enrollment[scope] = { status: 'ENROLLED', ...result };
      } catch (error) {
        if (!(error instanceof EnrollmentError)) throw error;
        enrollment[scope] = {
          status: error.code,
          httpStatus: error.status,
          body: error.body.slice(0, 500),
        };
      }
    }
    const endNative = await operator.nativeBalance();
    recordEvidence('testnet-account', 'REAL_TESTNET', {
      label: OPERATOR_ACCOUNT_LABEL,
      chainId: network.chainId,
      exchange: network.exchange,
      owner: operator.address,
      collateral: { ...collateral, label: collateral.label },
      perplAccountId: account!.accountId.toString(),
      exchangeBalance: account!.balance.toString(),
      faucetTx,
      approveTx: approveTx ?? previous?.approveTx ?? null,
      createAccountTx: createdTx ?? previous?.createAccountTx ?? null,
      forwardingTx,
      forwardingEvent,
      transactions: [
        ...((previous?.transactions as unknown[]) ?? []),
        ...operator.transactions,
      ],
      monSpentThisRunWei: (startNative - endNative).toString(),
      enrollment,
    });
  });
});
