import { parseUnits } from 'viem';
export type WorkspacePayCommand = {
  vendor: string;
  amount: string;
  purpose: string;
  obligation: string;
};
export function parseWorkspacePay(text: string): WorkspacePayCommand | null {
  const m =
    /^(?:\/pay(?:@[a-z0-9_]+)?|pay(?:\s+(?:a\s+)?contractor)?)\s+(.+?)\s+((?:0|[1-9][0-9]*)(?:\.[0-9]{1,6})?)\s+usdc\s+for\s+(.+?)\s+(?:ref|#)\s*:?\s*(.+)$/i.exec(
      text.trim(),
    );
  if (!m) return null;
  return {
    vendor: m[1]!.trim(),
    amount: String(parseUnits(m[2]!, 6)),
    purpose: m[3]!.trim(),
    obligation: m[4]!.trim(),
  };
}
