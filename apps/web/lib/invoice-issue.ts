/** Checks the issuer's typed data against the terms the page shows. */

export type IssueTerms = Readonly<{
  invoiceId: string;
  number: string;
  payTo: string;
  dueDate: string;
  total: string;
  asset: Readonly<{ address: string; decimals: number }>;
  chain: Readonly<{ chainId: number }>;
  issueTypedData: Readonly<{
    domain: Readonly<{ chainId: number }>;
    message: Readonly<{
      invoiceId: string;
      number: string;
      payoutAddress: string;
      token: string;
      total: string;
      dueDate: string;
    }>;
  }> | null;
}>;

/** Decimal text → base units, exactly (no floating point). */
function baseUnits(decimal: string, decimals: number): string {
  const [whole, frac = ''] = decimal.split('.');
  return BigInt(
    `${whole}${frac.padEnd(decimals, '0').slice(0, decimals)}`,
  ).toString();
}

/** Fields where the message to sign differs from what this page shows. */
export function issueMismatches(v: IssueTerms): string[] {
  const t = v.issueTypedData;
  if (!t) return ['typed data'];
  const m = t.message;
  const bad: string[] = [];
  if (m.invoiceId !== v.invoiceId) bad.push('invoice id');
  if (m.number !== v.number) bad.push('number');
  if (m.payoutAddress.toLowerCase() !== v.payTo.toLowerCase())
    bad.push('payout address');
  if (m.token.toLowerCase() !== v.asset.address.toLowerCase())
    bad.push('token');
  if (m.total !== baseUnits(v.total, v.asset.decimals)) bad.push('total');
  if (m.dueDate !== v.dueDate) bad.push('due date');
  if (t.domain.chainId !== v.chain.chainId) bad.push('chain');
  return bad;
}
