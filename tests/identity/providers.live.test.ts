import { describe, expect, it } from 'vitest';
import { encodeFunctionData, erc20Abi } from 'viem';
import {
  DynamicAdapter,
  MemoryIdentityStore,
  PrincipalService,
  PrivyAdapter,
  enrollProviderPrincipal,
} from '../../packages/identity/src/server.js';
import type { DelegationPolicy } from '@synq/schemas';
import { addr, testAusd } from './fixtures.js';

const privy = new PrivyAdapter(process.env);
const dynamic = new DynamicAdapter(process.env);
const privyBlocked = privy.status().status === 'BLOCKED';
const dynamicBlocked = dynamic.status().status === 'BLOCKED';

describe.skipIf(privyBlocked)(
  `Privy live sandbox ${privyBlocked ? '[BLOCKED-EXTERNAL: PRIVY_APP_ID/PRIVY_APP_SECRET/PRIVY_AUTHORIZATION_PRIVATE_KEY absent]' : ''}`,
  () => {
    it('creates a delegate wallet, proves possession, attaches a capped policy and is denied above the cap', async () => {
      const principals = new PrincipalService(new MemoryIdentityStore(), {
        profile: 'sandbox/monad-testnet',
        rpId: 'localhost',
        origin: 'http://localhost:3100',
      });
      const wallet = await privy.createDelegateWallet({
        externalId: `synq-live-${Date.now()}`,
      });
      const principal = await enrollProviderPrincipal(
        principals,
        'PRIVY_DELEGATE',
        {
          address: wallet.address,
          providerRef: wallet.walletId,
          signTypedData: (typed) => privy.signTypedData(wallet.walletId, typed),
        },
      );
      expect(principal.signer).toBe(wallet.address);
      const recipient = addr(0xacc);
      const policy: DelegationPolicy = {
        schemaVersion: 1,
        policyId: `live_${Date.now()}`,
        groupId: 'live' as DelegationPolicy['groupId'],
        delegatePrincipalId: principal.principalId,
        delegatorMemberId: 'member_0' as DelegationPolicy['delegatorMemberId'],
        asset: testAusd,
        recipient,
        maxAmountPerPeriod: '20000000',
        maxAmountPerExecution: '20000000',
        periodSeconds: 604800,
        maxExecutionsPerPeriod: 1,
        minIntervalSeconds: 0,
        validAfter: Math.floor(Date.now() / 1000) - 60,
        validUntil: Math.floor(Date.now() / 1000) + 86400,
        revokedAt: null,
      };
      await privy.attachPolicy(
        wallet.walletId,
        await privy.createPolicy(policy),
      );
      const transfer = (amount: bigint) =>
        privy.signErc20Transfer(wallet.walletId, {
          chainId: 10143,
          token: testAusd.address,
          data: encodeFunctionData({
            abi: erc20Abi,
            functionName: 'transfer',
            args: [recipient, amount],
          }),
        });
      await expect(transfer(20_000_001n)).rejects.toMatchObject({
        code: 'PROVIDER_ERROR',
      });
      expect(await transfer(20_000_000n)).toMatch(/^0x/);
    }, 60_000);
  },
);

describe.skipIf(dynamicBlocked)(
  `Dynamic live environment ${dynamicBlocked ? '[BLOCKED-EXTERNAL: DYNAMIC_ENVIRONMENT_ID/DYNAMIC_API_KEY absent]' : ''}`,
  () => {
    it('verifies the API token against the configured environment', async () => {
      expect((await dynamic.verifyEnvironment()).environmentId).toBe(
        process.env.DYNAMIC_ENVIRONMENT_ID,
      );
    }, 30_000);
  },
);
