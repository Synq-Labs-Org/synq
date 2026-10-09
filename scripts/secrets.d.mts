export function trackedFiles(root: string): string[];
export function scanRepository(root: string): {
  scanned: number;
  violations: { file: string; rule: string }[];
};
