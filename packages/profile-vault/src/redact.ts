function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

const RULES: [RegExp, (m: string) => string][] = [
  [
    /\b(?:\d[ -]?){13,19}\b/g,
    (m) => (luhn(m.replace(/\D/g, '')) ? '[PAN]' : m),
  ],
  [
    /\b(cvc|cvv|cvv2|cid|security code)\b\s*[:=#]?\s*\d{3,4}\b/gi,
    () => '[CVC]',
  ],
  [
    /\b(passport(?: number| no\.?)?)\s*[:=#]?\s*[A-Z0-9]{6,12}\b/gi,
    () => '[PASSPORT]',
  ],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, () => '[EMAIL]'],
  [/\+[1-9][0-9 ()-]{6,18}[0-9]/g, () => '[PHONE]'],
  [
    /\b(duffel_(?:test|live)_[A-Za-z0-9_-]+|sk_(?:staging|production)_[A-Za-z0-9]+)\b/g,
    () => '[SECRET]',
  ],
  [/\b(bearer)\s+[A-Za-z0-9._~+/=-]{12,}/gi, () => 'Bearer [SECRET]'],
  [
    /\b(cookie|set-cookie)\s*:\s*[^\n]+/gi,
    (m) => `${m.split(':')[0]}: [COOKIE]`,
  ],
];

/** Redacts card data, identity documents, contact details and credentials for traces and chat. */
export function redact(text: string): string {
  let out = text;
  for (const [re, fn] of RULES) out = out.replace(re, fn);
  return out;
}

export function redactDeep<T>(value: T): T {
  if (typeof value === 'string') return redact(value) as T;
  if (Array.isArray(value)) return value.map(redactDeep) as T;
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, redactDeep(v)]),
    ) as T;
  return value;
}
