function bytes4(value: unknown): string {
  const selector = String(value);
  if (/^0x[0-9a-fA-F]{8}$/.test(selector)) return selector;
  if (/^0x[0-9a-fA-F]{8}0{56}$/.test(selector)) return selector.slice(0, 10);
  throw new Error('Envio bytes4 selector has invalid length/padding');
}

export function canonicalEventPayload(params: object): Record<string, unknown> {
  const payload = JSON.parse(
    JSON.stringify(params, (_, value: unknown) =>
      typeof value === 'bigint' ? value.toString() : value,
    ),
  ) as Record<string, unknown>;
  if ('selector' in payload) payload.selector = bytes4(payload.selector);
  if ('callSelectors' in payload) {
    if (!Array.isArray(payload.callSelectors))
      throw new Error('Envio callSelectors is not a list');
    payload.callSelectors = payload.callSelectors.map(bytes4);
  }
  return payload;
}

export function treasuryAssets(raw: string | undefined): Set<string> {
  const list = (raw ?? '')
    .split(',')
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
  if (!list.length || list.some((x) => !/^0x[0-9a-f]{40}$/.test(x)))
    throw new Error('SYNQ_TREASURY_ASSETS must list registry asset addresses');
  return new Set(list);
}
