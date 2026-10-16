import { encodeAbiParameters, keccak256, type Hex } from 'viem';
import type { Invoice } from './index.js';
export type InvoiceSigningTerms = Pick<
  Invoice,
  | 'invoiceId'
  | 'number'
  | 'version'
  | 'issuer'
  | 'asset'
  | 'lineItems'
  | 'taxRateBps'
  | 'total'
  | 'dueDate'
>;

export function termsHash(i: InvoiceSigningTerms): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'string' },
        { type: 'uint256' },
        { type: 'address' },
        { type: 'uint256' },
        { type: 'address' },
        { type: 'string[]' },
        { type: 'uint256[]' },
        { type: 'uint256[]' },
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'string' },
      ],
      [
        i.invoiceId,
        BigInt(i.version),
        i.issuer.payoutAddress,
        BigInt(i.asset.chainId),
        i.asset.address,
        i.lineItems.map((l) => l.description),
        i.lineItems.map((l) => BigInt(l.quantity)),
        i.lineItems.map((l) => l.unitPrice),
        BigInt(i.taxRateBps),
        i.total,
        i.dueDate,
      ],
    ),
  );
}

/** What the issuer signs to send the invoice. */
export function issueTypedData(i: InvoiceSigningTerms) {
  return {
    domain: { name: 'Synq Invoice', version: '1', chainId: i.asset.chainId },
    types: {
      IssueInvoice: [
        { name: 'invoiceId', type: 'string' },
        { name: 'number', type: 'string' },
        { name: 'version', type: 'uint256' },
        { name: 'payoutAddress', type: 'address' },
        { name: 'token', type: 'address' },
        { name: 'total', type: 'uint256' },
        { name: 'dueDate', type: 'string' },
        { name: 'termsHash', type: 'bytes32' },
      ],
    },
    primaryType: 'IssueInvoice' as const,
    message: {
      invoiceId: i.invoiceId,
      number: i.number,
      version: BigInt(i.version),
      payoutAddress: i.issuer.payoutAddress,
      token: i.asset.address,
      total: i.total,
      dueDate: i.dueDate,
      termsHash: termsHash(i),
    },
  };
}
