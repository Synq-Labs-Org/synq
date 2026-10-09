export function parseCsv(text: string): {
  header: string[];
  rows: Record<string, string>[];
};
export function toCsv(header: string[], rows: Record<string, string>[]): string;
