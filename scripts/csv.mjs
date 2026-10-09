export function parseCsv(text) {
  const rows = [];
  let row = [],
    field = '',
    quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length) rows.push([...row, field]);
  const [header = [], ...body] = rows.filter((r) => r.some((v) => v !== ''));
  return {
    header,
    rows: body.map((r) =>
      Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])),
    ),
  };
}
export function toCsv(header, rows) {
  const cell = (v) => (/[",\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v);
  return (
    [header, ...rows.map((r) => header.map((h) => r[h] ?? ''))]
      .map((r) => r.map((v) => cell(String(v))).join(','))
      .join('\n') + '\n'
  );
}
