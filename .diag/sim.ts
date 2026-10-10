import { createPublicClient, http, encodeFunctionData, erc20Abi, pad, numberToHex } from 'viem';
import { monadMainnetProfile } from '@synq/chain-registry';
import { KuruFlowAdapter, KuruFlowClient, kuruDeployment, simulateSwap, findBalanceSlot } from '@synq/plugin-kuru';
import { ACCOUNT } from '../tests/kuru/fixtures.js';
const client = createPublicClient({ transport: http(monadMainnetProfile.defaultRpcUrl) });
const fc = new KuruFlowClient({ fetch: (u, i) => fetch(u, i), clock: Date });
const flow = new KuruFlowAdapter(fc);
const m = kuruDeployment('proof/monad-mainnet');
const quote = await flow.quote({ profile: 'proof/monad-mainnet', account: ACCOUNT, tokenIn: m.tokens.AUSD!.address, tokenOut: m.tokens.WMON!.address, amountIn: 1_000_000n, slippageBps: 50 }, Date.now());
const p = flow.prepare(quote, { maxSlippageBps: 75, maxInputAmount: 1_000_000n, now: Date.now() });
const r = await simulateSwap(client, { account: p.account, tokenIn: p.tokenIn, tokenOut: p.tokenOut, amountIn: p.amountIn, approval: p.approval, swap: p.swap });
console.log(JSON.stringify(r, null, 1));
// variant: no blockNumber pin, raw request with traceTransfers
const { slot, shift } = await findBalanceSlot(client, p.tokenIn, p.account);
for (const variant of ['latest', 'pinned-noapprove']) {
  const calls: any[] = [];
  if (variant !== 'pinned-noapprove') calls.push({ from: p.account, to: p.approval!.token, data: p.approval!.calldata });
  calls.push({ from: p.account, to: p.swap.target, data: p.swap.calldata });
  const res: any = await client.request({ method: 'eth_simulateV1' as never, params: [{ blockStateCalls: [{ calls, stateOverrides: { [p.tokenIn]: { stateDiff: { [slot]: pad(numberToHex(p.amountIn << BigInt(shift))) } } } }] }, 'latest'] as never });
  console.log(variant, JSON.stringify(res[0].calls.map((c: any) => ({ s: c.status, e: c.error, d: c.returnData?.slice(0, 74) }))));
}
