import { parseUnits } from 'viem';
export type WorkspaceInvoiceCommand = {
  payerName: string;
  amount: string;
  dueDate: string;
  description: string;
};
/**
 * `invoice <payer> <amount> USDC due <YYYY-MM-DD> for <work>` drafts an
 * invoice. A draft moves nothing; issuing it needs the owner's wallet
 * signature on the secure page.
 */
export function parseWorkspaceInvoice(
  text: string,
): WorkspaceInvoiceCommand | null {
  const m =
    /^\/?invoice(?:@[a-z0-9_]+)?\s+(.+?)\s+((?:0|[1-9][0-9]*)(?:\.[0-9]{1,6})?)\s+usdc\s+due\s+(\d{4}-\d{2}-\d{2})\s+for\s+(.+)$/i.exec(
      text.trim(),
    );
  if (!m) return null;
  const amount = parseUnits(m[2]!, 6);
  if (amount <= 0n) return null;
  return {
    payerName: m[1]!.trim().slice(0, 120),
    amount: String(amount),
    dueDate: m[3]!,
    description: m[4]!.trim().slice(0, 200),
  };
}
