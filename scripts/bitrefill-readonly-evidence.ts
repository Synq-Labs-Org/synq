/**
 * Bitrefill read-only evidence (MAINNET_READ_ONLY). Auth, catalog search,
 * product details, denomination/country/currency validation, payment-method
 * discovery and the router's network/asset check against the Monad AUSD
 * treasury. Never pays: the real-money gate is exercised and denies.
 * Writes bounty-evidence/commerce/bitrefill-readonly-<ts>.json.
 *
 *   set -a; . ~/.synq/p11.env; set +a
 *   node --import tsx scripts/bitrefill-readonly-evidence.ts
 *
 * Env: BITREFILL_API_KEY (Personal) or BITREFILL_API_ID + BITREFILL_API_SECRET
 * (Business). Optional BITREFILL_ALLOW_INVOICE_PREVIEW=true creates one
 * UNPAID crypto invoice (no money moves; it expires). Without credentials
 * it records BLOCKED_EXTERNAL and exits 0.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BITREFILL_PAYMENT_METHODS,
  BitrefillClient,
  RealMoneyGate,
  bitrefillConfigFromEnv,
  settlementFabricCapabilities,
  treasuryCanPay,
  validateBitrefillPurchase,
  type HttpFetch,
} from '@synq/plugin-commerce';
import { selectExecutionRoute } from '@synq/settlement';

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const dir = join(process.cwd(), 'bounty-evidence', 'commerce');
const secrets = [
  process.env.BITREFILL_API_KEY,
  process.env.BITREFILL_API_ID,
  process.env.BITREFILL_API_SECRET,
].filter((s): s is string => !!s);

function write(report: unknown) {
  const text = JSON.stringify(report, null, 2);
  if (secrets.some((s) => text.includes(s)))
    throw new Error('secret leaked into evidence');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `bitrefill-readonly-${stamp}.json`);
  writeFileSync(file, text + '\n');
  return file;
}

const realFetch: HttpFetch = async (url, init) => {
  const res = await fetch(url, {
    method: init.method,
    headers: init.headers,
    ...(init.body !== undefined ? { body: init.body } : {}),
    signal: init.signal ?? AbortSignal.timeout(30_000),
  });
  return { status: res.status, text: () => res.text() };
};

async function main() {
  const config = bitrefillConfigFromEnv(process.env);
  if (!config) {
    const file = write({
      generatedAt: new Date().toISOString(),
      label: 'BLOCKED_EXTERNAL',
      missing: [
        'BITREFILL_API_KEY (or BITREFILL_API_ID + BITREFILL_API_SECRET)',
      ],
      signup: 'https://www.bitrefill.com/account/developers (Personal API key)',
      blocker: 'reports/blockers/V13-20261012T061000Z-bitrefill-credentials.md',
    });
    console.log(`BLOCKED_EXTERNAL -> ${file}`);
    return;
  }
  const client = new BitrefillClient(config, realFetch, {
    allowInvoicePreview: process.env.BITREFILL_ALLOW_INVOICE_PREVIEW === 'true',
  });
  const pong = await client.ping();
  const results = await client.searchProducts('amazon', 10);
  const target = results.find((p) => p.countryCode === 'US') ?? results[0];
  const product = target ? await client.product(target.id) : null;
  const validation = product
    ? validateBitrefillPurchase(product, {
        countryCode: product.countryCode || 'US',
        currency: product.currency,
        value: product.packages[0]?.value ?? product.range?.min ?? 10,
      })
    : null;
  const treasury = [{ chain: 'monad-testnet', asset: 'AUSD' }];
  const methods = Object.keys(BITREFILL_PAYMENT_METHODS).map((m) => ({
    method: m,
    ...BITREFILL_PAYMENT_METHODS[m]!,
    payableByTreasury: treasuryCanPay(m, treasury),
  }));
  const route = selectExecutionRoute(
    {
      intentId: 'bitrefill-evidence',
      product: 'GIFT_CARD',
      currency: 'USD',
      requiredChain: { chain: 'base', asset: 'USDC' },
      allowedModes: ['MAINNET_READ_ONLY', 'REAL_MONEY_APPROVAL_REQUIRED'],
      categories: ['CRYPTO_COMMERCE_REAL', 'HUMAN_HANDOFF'],
    },
    settlementFabricCapabilities(process.env),
  );
  const gate = new RealMoneyGate(process.env);
  const gateDecision = gate.authorize({
    mode: 'MAINNET_READ_ONLY',
    invoiceId: 'none',
    amountMinor: 1_000n,
    currency: 'USD',
    approval: null,
    now: Math.floor(Date.now() / 1000),
  });
  let preview: unknown =
    'not requested (BITREFILL_ALLOW_INVOICE_PREVIEW unset)';
  if (
    process.env.BITREFILL_ALLOW_INVOICE_PREVIEW === 'true' &&
    product &&
    validation?.ok
  )
    preview = await client.previewInvoice({
      productId: product.id,
      packageId: validation.packageId,
      value: validation.value,
      paymentMethod: 'usdc_base',
    });
  const file = write({
    generatedAt: new Date().toISOString(),
    label: 'MAINNET_READ_ONLY',
    apiKind: client.kind,
    productionMultiUser:
      client.kind === 'BUSINESS'
        ? 'BUSINESS API'
        : 'PARTNER_GATED (Personal API)',
    ping: pong,
    search: results.map((p) => ({
      id: p.id,
      name: p.name,
      country: p.countryCode,
      currency: p.currency,
    })),
    product,
    validation,
    paymentMethods: methods,
    router: route,
    realMoneyGate: gateDecision,
    invoicePreview: preview,
    note: 'No invoice was paid. Synq has no Bitrefill payment path.',
  });
  console.log(
    `MAINNET_READ_ONLY ping=${pong} products=${results.length} -> ${file}`,
  );
}

try {
  await main();
} catch (e) {
  let msg = String((e as Error).message);
  for (const s of secrets) msg = msg.split(s).join('[REDACTED]');
  console.error(msg);
  process.exitCode = 1;
}
