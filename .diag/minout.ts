import { createPublicClient, http, pad, numberToHex, encodeAbiParameters } from 'viem';
import { monadMainnetProfile } from '@synq/chain-registry';
import { KuruFlowAdapter, KuruFlowClient, kuruDeployment, findBalanceSlot } from '@synq/plugin-kuru';
import { ACCOUNT } from '../tests/kuru/fixtures.js';
const client = createPublicClient({ transport: http(monadMainnetProfile.defaultRpcUrl) });
const fc = new KuruFlowClient({ fetch: (u, i) => fetch(u, i), clock: Date });
const flow = new KuruFlowAdapter(fc);
const m = kuruDeployment('proof/monad-mainnet');
const quote = await flow.quote({ profile: 'proof/monad-mainnet', account: ACCOUNT, tokenIn: m.tokens.AUSD!.address, tokenOut: m.tokens.WMON!.address, amountIn: 1_000_000n, slippageBps: 50 }, Date.now());
const p = flow.prepare(quote, { maxSlippageBps: 75, maxInputAmount: 1_000_000n, now: Date.now() });
const { slot, shift } = await findBalanceSlot(client, p.tokenIn, p.account);
const minOutWord = p.swap.calldata.slice(10 + 64, 10 + 128);
const out: any[] = [];
for (const [label, minOut] of [['as-quoted', p.decoded.minAmountOut], ['quoted+0.5%', (p.quotedOutput * 10050n) / 10000n], ['2x', p.quotedOutput * 2n]] as const) {
  const data = (p.swap.calldata.slice(0, 74) + minOut.toString(16).padStart(64, '0') + p.swap.calldata.slice(138)) as `0x${string}`;
  const res: any = await client.request({ method: 'eth_simulateV1' as never, params: [{ blockStateCalls: [{ calls: [{ from: p.account, to: p.approval!.token, data: p.approval!.calldata }, { from: p.account, to: p.swap.target, data }], stateOverrides: { [p.tokenIn]: { stateDiff: { [slot]: pad(numberToHex(p.amountIn << BigInt(shift))) } } } }] }, 'latest'] as never });
  const c = res[0].calls[1];
  out.push({ label, minOut: minOut.toString(), status: c.status, returnData: c.returnData.slice(0, 74) });
}
console.log(JSON.stringify({ observedAt: new Date().toISOString(), minOutWordInCalldata: BigInt('0x' + minOutWord).toString(), quotedOutput: p.quotedOutput.toString(), decodedMinOut: p.decoded.minAmountOut.toString(), results: out }, null, 1));
