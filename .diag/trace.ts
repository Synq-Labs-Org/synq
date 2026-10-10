import { createPublicClient, http, encodeFunctionData, erc20Abi, pad, numberToHex, keccak256, encodeAbiParameters } from 'viem';
import { monadMainnetProfile } from '@synq/chain-registry';
import { KuruFlowAdapter, KuruFlowClient, kuruDeployment, findBalanceSlot } from '@synq/plugin-kuru';
import { ACCOUNT } from '../tests/kuru/fixtures.js';
import { writeFileSync } from 'node:fs';

const client = createPublicClient({ transport: http(monadMainnetProfile.defaultRpcUrl) });
const fc = new KuruFlowClient({ fetch: (u, i) => fetch(u, i), clock: Date });
const flow = new KuruFlowAdapter(fc);
const m = kuruDeployment('proof/monad-mainnet');
const account = (process.env.ACCT as `0x${string}`) ?? ACCOUNT;
const raw = await fc.quote({ userAddress: account.toLowerCase() as any, tokenIn: m.tokens.AUSD!.address, tokenOut: m.tokens.WMON!.address, amount: 1_000_000n, slippageBps: 50 });
const quote = await flow.quote({ profile: 'proof/monad-mainnet', account, tokenIn: m.tokens.AUSD!.address, tokenOut: m.tokens.WMON!.address, amountIn: 1_000_000n, slippageBps: 50 }, Date.now());
const p = flow.prepare(quote, { maxSlippageBps: 75, maxInputAmount: 1_000_000n, now: Date.now() });
const { slot, shift } = await findBalanceSlot(client, p.tokenIn, account);
console.log('entry', m.flowEntrypoint, 'router', m.router, 'swap.to', p.swap.target, 'value', p.swap.value, 'slot', slot, shift);
// allowance slot: probe via prestate tracer
const allowData = encodeFunctionData({ abi: erc20Abi, functionName: 'allowance', args: [account, p.swap.target] });
const tr: any = await client.request({ method: 'debug_traceCall' as never, params: [{ to: p.tokenIn, data: allowData }, 'latest', { tracer: 'prestateTracer' }] as never });
const aslots = Object.keys(tr[p.tokenIn.toLowerCase()]?.storage ?? {});
console.log('allowance read slots', aslots);
const big = pad(numberToHex(1_000_000n));
const overrides: any = { [p.tokenIn]: { stateDiff: { [slot]: pad(numberToHex(1_000_000n << BigInt(shift))), ...Object.fromEntries(aslots.filter((s) => !s.startsWith("0x3608")).map((s) => [s, big])) } } };
const t: any = await client.request({ method: 'debug_traceCall' as never, params: [{ from: account, to: p.swap.target, data: p.swap.calldata, value: numberToHex(p.swap.value) }, 'latest', { tracer: 'callTracer', stateOverrides: overrides }] as never });
writeFileSync(process.env.OUT ?? '.diag/trace.json', JSON.stringify({ raw, quoteId: quote.quoteId, decoded: p.decoded, trace: t }, (k, v) => typeof v === 'bigint' ? v.toString() : v, 2));
const walk = (c: any, d = 0) => { console.log(' '.repeat(d * 2) + `${c.type} ${c.to} ${c.input?.slice(0, 10)} err=${c.error ?? ''} out=${c.output?.slice(0, 74) ?? ''}`); for (const s of c.calls ?? []) walk(s, d + 1); };
walk(t);
