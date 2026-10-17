import { parseUnits } from 'viem';
export type WorkspacePayCommand = {
  vendor: string;
  amount: string;
  purpose: string;
  obligation: string;
};
const AMOUNT = String.raw`((?:0|[1-9][0-9]*)(?:\.[0-9]{1,6})?)`;
const REF = String.raw`(?:ref|reference|invoice|bill|#)\s*:?\s*([^\s,;]+(?:\s+[^\s,;]+)?)`;
/**
 * Deterministic payout grammar: every field is read from the message itself,
 * never inferred. Accepted forms:
 *  - pay <vendor> <amount> USDC for <purpose> ref <reference>
 *  - pay|send <amount> USDC to <vendor> for <purpose>, invoice <reference>
 */
export function parseWorkspacePay(text: string): WorkspacePayCommand | null {
  const t = text.trim().replace(/[.!]+$/, '');
  const a =
    /^(?:\/pay(?:@[a-z0-9_]+)?|pay(?:\s+(?:a\s+)?contractor)?)\s+(.+?)\s+((?:0|[1-9][0-9]*)(?:\.[0-9]{1,6})?)\s+usdc\s+for\s+(.+?)\s+(?:ref|#)\s*:?\s*(.+)$/i.exec(
      t,
    );
  if (a)
    return {
      vendor: a[1]!.trim(),
      amount: String(parseUnits(a[2]!, 6)),
      purpose: a[3]!.trim(),
      obligation: a[4]!.trim(),
    };
  const b = new RegExp(
    String.raw`^(?:\/?pay|send)\s+${AMOUNT}\s+usdc\s+to\s+(.+?)\s+for\s+(.+?)\s*[,;]?\s+${REF}$`,
    'i',
  ).exec(t);
  if (b)
    return {
      vendor: b[2]!.trim(),
      amount: String(parseUnits(b[1]!, 6)),
      purpose: b[3]!.trim(),
      obligation: b[4]!.trim(),
    };
  return null;
}
