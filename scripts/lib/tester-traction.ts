import { z } from 'zod';
import type { MemoPayment } from '@synq/invoices';

const Address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const Hash = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
export const TesterManifestSchema = z.strictObject({
  version: z.literal(1),
  chainId: z.literal(5042002),
  token: Address,
  memoContract: Address,
  controlledWallets: z.array(Address).min(4),
  invoices: z.array(
    z.strictObject({
      testerId: z.string().regex(/^[a-zA-Z0-9_-]{1,48}$/),
      invoiceId: z.string(),
      paymentRef: Hash,
      recipient: Address,
      totalBaseUnits: z.string().regex(/^[1-9]\d*$/),
      fromBlock: z.string().regex(/^\d+$/),
      expiresAt: z.number().int(),
      issuedAt: z.number().int(),
      checkoutUrl: z.url(),
    }),
  ),
});
export type TesterManifest = z.output<typeof TesterManifestSchema>;

/** Only receipt-verified Memo payments for the issued tester references count. */
export function tallyTesterPayments(
  manifest: TesterManifest,
  payments: readonly MemoPayment[],
  controlled: readonly string[],
) {
  const excluded = new Set(
    [...manifest.controlledWallets, ...controlled].map((a) => a.toLowerCase()),
  );
  const refs = new Map(
    manifest.invoices.map((i) => [i.paymentRef.toLowerCase(), i]),
  );
  if (refs.size !== manifest.invoices.length)
    throw new Error('duplicate tester payment reference');
  const seen = new Set<string>();
  const external: {
    testerId: string;
    invoiceId: string;
    payer: string;
    hash: string;
    logIndex: number;
    amountBaseUnits: string;
  }[] = [];
  let controlledPayments = 0;
  for (const p of payments) {
    const i = refs.get(p.paymentRef.toLowerCase());
    if (
      !i ||
      p.chainId !== manifest.chainId ||
      p.recipient.toLowerCase() !== i.recipient.toLowerCase() ||
      p.amount <= 0n
    )
      continue;
    const key = `${p.chainId}:${p.txHash.toLowerCase()}:${p.logIndex}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (excluded.has(p.payer.toLowerCase())) {
      controlledPayments++;
      continue;
    }
    external.push({
      testerId: i.testerId,
      invoiceId: i.invoiceId,
      payer: p.payer.toLowerCase(),
      hash: p.txHash,
      logIndex: p.logIndex,
      amountBaseUnits: String(p.amount),
    });
  }
  const paidByInvoice = new Map<string, bigint>();
  for (const p of external)
    paidByInvoice.set(
      p.invoiceId,
      (paidByInvoice.get(p.invoiceId) ?? 0n) + BigInt(p.amountBaseUnits),
    );
  return {
    external,
    distinctExternalPayerWallets: new Set(external.map((p) => p.payer)).size,
    externalPaymentTransactions: new Set(
      external.map((p) => p.hash.toLowerCase()),
    ).size,
    grossExternalBaseUnits: String(
      external.reduce((n, p) => n + BigInt(p.amountBaseUnits), 0n),
    ),
    invoiceVolumeBaseUnits: String(
      [...paidByInvoice].reduce((n, [id, paid]) => {
        const total = BigInt(
          manifest.invoices.find((i) => i.invoiceId === id)!.totalBaseUnits,
        );
        return n + (paid < total ? paid : total);
      }, 0n),
    ),
    controlledPaymentsExcluded: controlledPayments,
  };
}
