export function canonicalEventPayload(params: object): Record<string, unknown> {
  const payload = JSON.parse(
    JSON.stringify(params, (_, value: unknown) =>
      typeof value === 'bigint' ? value.toString() : value,
    ),
  ) as Record<string, unknown>;
  if ('selector' in payload) {
    const selector = String(payload.selector);
    if (/^0x[0-9a-fA-F]{8}$/.test(selector)) payload.selector = selector;
    else if (/^0x[0-9a-fA-F]{8}0{56}$/.test(selector))
      payload.selector = selector.slice(0, 10);
    else throw new Error('Envio bytes4 selector has invalid length/padding');
  }
  return payload;
}
